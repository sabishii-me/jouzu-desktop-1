use crate::chat_transport::{encode_command, JsonlDecoder};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 32 * 1024 * 1024;
/// How much of the runtime's own stderr is kept for one session. It stays in
/// memory while the session runs and is written once when the session ends, so a
/// healthy session persists nothing the runtime printed.
const STDERR_TAIL: usize = 8 * 1024;
const HARD_BYTES: usize = 64 * 1024 * 1024;
// A slow consumer is a desktop problem. Crossing the soft limit compacts the
// unread queue and keeps the turn alive; only a wedged runtime reaches the hard
// limit, where the runtime is stopped instead of the transcript being trusted.
const SOFT_RECORDS: usize = 512;
const SOFT_BYTES: usize = 16 * 1024 * 1024;
const HARD_RECORDS: usize = 4096;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

// Root exit and pipe EOF are independent: descendants can inherit stdout, and
// stdout can close before the root's exit status becomes available.
#[derive(Default)]
struct ExitDrain {
    code: Option<u32>,
    eof: bool,
    deadline: Option<Instant>,
}
impl ExitDrain {
    fn observe_exit(&mut self, code: u32, now: Instant) {
        self.code.get_or_insert(code);
        self.deadline.get_or_insert(now + EXIT_DRAIN_TIMEOUT);
    }
    fn accepts_input(&self) -> bool {
        self.deadline.is_none()
    }
    fn read_stdout(
        &mut self,
        now: Instant,
        decoder: &mut JsonlDecoder,
        mut read: impl FnMut(&mut [u8]) -> std::io::Result<usize>,
        mut record: impl FnMut(serde_json::Map<String, Value>),
    ) -> Result<(), String> {
        if self.eof {
            return Ok(());
        }
        let mut buffer = [0; 16384];
        // This is a fairness budget, not an exit-drain budget.
        for _ in 0..16 {
            match read(&mut buffer) {
                Ok(0) => {
                    self.eof = true;
                    self.deadline.get_or_insert(now + EXIT_DRAIN_TIMEOUT);
                    break;
                }
                Ok(count) => decoder
                    .feed(&buffer[..count], &mut record)
                    .map_err(|e| e.to_string())?,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(format!("Runtime output failed: {e}")),
            }
        }
        Ok(())
    }
    fn done(&self, now: Instant) -> bool {
        (self.code.is_some() && self.eof) || self.deadline.is_some_and(|end| now >= end)
    }
    fn finish(&self, decoder: &mut JsonlDecoder, failure: &mut Option<String>) {
        if let Some(code) = self.code {
            append_error(
                failure,
                format!("Runtime exited ({code}); unfinished work was not replayed"),
            );
        }
        if self.deadline.is_some() {
            if !self.eof {
                append_error(
                    failure,
                    "Runtime stdout drain incomplete; output may be incomplete".into(),
                );
            } else if self.code.is_none() {
                append_error(
                    failure,
                    "Runtime stdout closed before exit status was available; session interrupted"
                        .into(),
                );
            }
            if let Err(error) = decoder.finish() {
                append_error(failure, error.to_string());
            }
        }
    }
}
/// Records a pending request must always receive, and the ones that only draw.
fn is_structural(record: &Value) -> bool {
    let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
    matches!(
        kind,
        "response"
            | "extension_ui_request"
            | "extension_error"
            | "message_start"
            | "message_end"
            | "agent_start"
            | "agent_end"
            | "agent_settled"
            | "compaction_start"
            | "compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
            | "turn_start"
            | "turn_end"
            | "tool_start"
            | "tool_end"
            | "error"
    )
}

/// Drop verbose backlog oldest-first until the queue is under the soft limits.
/// Structural records survive, and one `desktop_gap` marker tells the view to
/// reconcile from the durable transcript once the turn settles.
fn compact_backlog(output: &mut Output) {
    if output.records.len() <= SOFT_RECORDS && output.bytes <= SOFT_BYTES {
        return;
    }
    let before = output.records.len();
    let mut kept: VecDeque<Value> = VecDeque::with_capacity(before);
    let mut bytes = 0usize;
    let mut dropped = 0usize;
    let mut dropped_bytes = 0usize;
    // Structural records are rare and small; verbose ones are what grows.
    for record in output.records.drain(..) {
        if is_structural(&record) {
            bytes += serde_json::to_vec(&record).map_or(0, |value| value.len());
            kept.push_back(record);
        } else {
            dropped += 1;
            dropped_bytes += serde_json::to_vec(&record).map_or(0, |value| value.len());
        }
    }
    output.records = kept;
    output.bytes = bytes;
    if dropped > 0 {
        output.dropped = output.dropped.saturating_add(dropped);
        output.records.push_back(serde_json::json!({
            "type": "desktop_gap",
            "dropped": dropped,
            "bytes": dropped_bytes,
        }));
        if let Ok(size) = serde_json::to_vec(output.records.back().unwrap()) {
            output.bytes += size.len();
        }
    }
}

fn append_error(error: &mut Option<String>, message: String) {
    if let Some(error) = error {
        error.push_str("; ");
        error.push_str(&message);
    } else {
        *error = Some(message);
    }
}
#[derive(Default)]
struct Output {
    records: VecDeque<Value>,
    bytes: usize,
    closed: bool,
    error: Option<String>,
    cleanup_error: Option<String>,
    /// How many records the last soft compaction dropped, so the webview learns
    /// once that its view is behind the transcript.
    dropped: usize,
}
struct Session {
    owner: String,
    generation: String,
    key: String,
    last_poll: Instant,
    input: mpsc::SyncSender<Vec<u8>>,
    stop: mpsc::Sender<()>,
    output: Arc<Mutex<Output>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
#[derive(Default)]
pub struct ChatService {
    sessions: Mutex<HashMap<String, Session>>,
}
#[derive(Serialize)]
pub struct Poll {
    records: Vec<Value>,
    closed: bool,
    error: Option<String>,
    /// Set while the view is behind the transcript after a compacted backlog.
    compacted: usize,
}
impl ChatService {
    /// Recover the session map even if a panic poisoned the mutex. Without this a
    /// single panic while the lock is held makes every later command fail with
    /// "Chat state unavailable", which disables every session until the app restarts.
    fn locked(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        match self.sessions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                if let Ok(root) = crate::runtime::managed_root() {
                    crate::logs::append(&root, "runtime.log", "sessions-lock-recovered");
                }
                poisoned.into_inner()
            }
        }
    }
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            stop_sessions(sessions.drain().map(|(_, session)| session).collect());
        }
    }
    /// Release the runtime and its shared update lock before an installer transaction.
    /// The desktop will reconnect the chat after the update completes.
    pub fn pause(&self) {
        self.shutdown();
    }
}
impl Drop for ChatService {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            stop_sessions(sessions.drain().map(|(_, session)| session).collect());
        }
    }
}
fn join_session(session: &mut Session) -> Result<(), String> {
    if let Some(worker) = session.worker.take() {
        worker.join().map_err(|_| "Chat cleanup worker failed")?;
    }
    let output = session
        .output
        .lock()
        .map_err(|_| "Chat output unavailable")?;
    match &output.cleanup_error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}
fn stop_sessions(mut sessions: Vec<Session>) {
    for session in &sessions {
        let _ = session.stop.send(());
    }
    for session in &mut sessions {
        let _ = join_session(session);
    }
}
fn stale_generation_handles(sessions: &HashMap<String, Session>, owner: &str, generation: &str) -> Vec<String> {
    sessions
        .iter()
        .filter(|(_, session)| session.owner == owner && session.generation != generation)
        .map(|(handle, _)| handle.clone())
        .collect()
}

fn reaped_handles(sessions: &HashMap<String, Session>, owner: &str, kept: &[String], now: Instant) -> Vec<String> {
    sessions
        .iter()
        .filter(|(handle, session)| {
            session.owner == owner
                && !kept.contains(handle)
                && now.duration_since(session.last_poll) > Duration::from_secs(60)
        })
        .map(|(handle, _)| handle.clone())
        .collect()
}

fn validate(request: &Value) -> Result<(), String> {
    let object = request
        .as_object()
        .ok_or("Chat request must be an object")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("Missing request type")?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Missing request id")?;
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid request id".into());
    }
    let fields: &[&str] = match kind {
        "get_state" | "get_messages" | "abort" | "clear_queue" | "new_session"
        | "get_available_models" | "get_available_thinking_levels" | "compact" | "get_session_stats" => &["type", "id"],
        "prompt" | "steer" => &["type", "id", "message", "images"],
        "switch_session" => &["type", "id", "sessionPath"],
        "fork" => &["type", "id", "entryId"],
        "get_fork_messages" => &["type", "id"],
        "export_html" => &["type", "id", "outputPath"],
        "set_model" => &["type", "id", "provider", "modelId"],
        "set_thinking_level" => &["type", "id", "level"],
        "extension_ui_response" => &["type", "id", "value", "confirmed", "cancelled"],
        _ => return Err("Unsupported desktop chat request".into()),
    };
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("Unexpected chat request field".into());
    }
    if matches!(kind, "prompt" | "steer")
        && !object
            .get("message")
            .is_some_and(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
    {
        return Err("Message must contain text".into());
    }
    if kind == "steer" && object.get("images").is_some() {
        return Err("Steering images are not supported by this desktop".into());
    }
    if matches!(kind, "prompt" | "steer") {
        if let Some(images) = object.get("images") {
            let images = images.as_array().ok_or("Images must be an array")?;
            if images.len() > 4 {
                return Err("At most four images are supported".into());
            }
            let mut total = 0usize;
            for image in images {
                let image = image.as_object().ok_or("Invalid image attachment")?;
                if image.len() != 3 || image.get("type").and_then(Value::as_str) != Some("image") {
                    return Err("Invalid image attachment fields".into());
                }
                if !matches!(
                    image.get("mimeType").and_then(Value::as_str),
                    Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
                ) {
                    return Err("Unsupported image type".into());
                }
                let data = image
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or("Missing image data")?;
                let padding = data.bytes().rev().take_while(|b| *b == b'=').count();
                if data.is_empty()
                    || data.len() % 4 != 0
                    || padding > 2
                    || !data[..data.len() - padding]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
                {
                    return Err("Invalid base64 image data".into());
                }
                total = total
                    .checked_add(data.len() / 4 * 3 - padding)
                    .ok_or("Image limit exceeded")?;
                let image_bytes = data.len() / 4 * 3 - padding;
                if image_bytes > MAX_IMAGE_BYTES {
                    return Err("Each image must be 10 MiB or less".into());
                }
                if total > MAX_TOTAL_IMAGE_BYTES {
                    return Err("Images must total 20 MiB or less".into());
                }
            }
        }
    }
    if kind == "switch_session" {
        let path = object
            .get("sessionPath")
            .and_then(Value::as_str)
            .ok_or("Missing session path")?;
        if path.contains('\0') || path.len() > 32767 || !std::path::Path::new(path).is_absolute() {
            return Err("Session path must be an absolute file path".into());
        }
    }
    if kind == "export_html" {
        let path = object
            .get("outputPath")
            .and_then(Value::as_str)
            .ok_or("Missing export path")?;
        if path.contains('\0') || path.len() > 32767 || !std::path::Path::new(path).is_absolute() {
            return Err("Export path must be an absolute file path".into());
        }
    }
    if kind == "set_model" {
        for key in ["provider", "modelId"] {
            let value = object
                .get(key)
                .and_then(Value::as_str)
                .ok_or("Missing model identity")?;
            if value.is_empty() || value.len() > 256 || value.contains('\0') {
                return Err("Invalid model identity".into());
            }
        }
    }
    if kind == "set_thinking_level" {
        let level = object
            .get("level")
            .and_then(Value::as_str)
            .ok_or("Missing thinking level")?;
        if level.is_empty() || level.len() > 64 || level.contains('\0') {
            return Err("Invalid thinking level".into());
        }
    }
    if kind == "extension_ui_response" {
        for key in ["confirmed", "cancelled"] {
            if object.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err("Invalid extension response".into());
            }
        }
        if object.get("value").is_some_and(|v| !v.is_string()) {
            return Err("Invalid extension response value".into());
        }
    }
    Ok(())
}
fn usable_environment_name(name: &std::ffi::OsStr) -> bool {
    // Windows exposes hidden per-drive variables such as `=C:` through vars_os. They are
    // not valid child environment names and are irrelevant to the runtime.
    let text = name.to_string_lossy();
    !text.is_empty() && !text.contains('=') && !text.contains('\0')
}
#[tauri::command]
pub fn chat_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    path: String,
    generation: Option<String>,
    key: Option<String>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Chat is restricted to the main window".into());
    }
    // A pool handle is generation-scoped: a page load releases the previous
    // generation explicitly, so a new handle must not stop other live sessions.
    // Legacy callers pass no generation and keep the single-runtime cleanup.
    if generation.is_none() {
        let stale: Vec<Session> = {
            let mut previous = state.locked();
            previous.drain().map(|(_, session)| session).collect()
        };
        stop_sessions(stale);
    }
    let mut sessions = state.locked();
    let cwd = std::fs::canonicalize(&path).map_err(|_| "Workspace folder is unavailable")?;
    if !cwd.is_dir() {
        return Err("Workspace must be a folder".into());
    }
    // Ownership is per session/branch. A pool slot keeps a unique key until it is
    // leased; the visible entry uses its session key. Only the same key is stopped.
    let session_key = key.unwrap_or_else(|| cwd.to_string_lossy().into_owned());
    let same: Vec<String> = sessions
        .iter()
        .filter(|(_, session)| session.key == session_key)
        .map(|(handle, _)| handle.clone())
        .collect();
    let previous: Vec<Session> = same
        .into_iter()
        .filter_map(|handle| sessions.remove(&handle))
        .collect();
    if !previous.is_empty() {
        drop(sessions);
        stop_sessions(previous);
        sessions = state.locked();
    }
    let root = crate::runtime::application_root(&app)?;
    let managed = crate::runtime::managed_root()?;
    let lease = crate::update_lock::lock(&managed, false)?;
    let slot = crate::active_app::resolve_app(&root, &managed)?;
    let bash = crate::git_environment::find(&managed)?;
    let mut environment: HashMap<String, (std::ffi::OsString, std::ffi::OsString)> =
        std::env::vars_os()
            .filter(|(key, _)| usable_environment_name(key))
            .map(|(key, value)| (key.to_string_lossy().to_ascii_uppercase(), (key, value)))
            .collect();
    for entry in crate::environment::environment_read()? {
        if entry.enabled {
            environment.insert(
                entry.name.to_ascii_uppercase(),
                (entry.name.into(), entry.value.into()),
            );
        }
    }
    for name in ["NODE_OPTIONS", "NODE_PATH"] {
        environment.remove(name);
    }
    for (name, value) in [
        (
            "JOUZU_HOME",
            crate::runtime::effective_home()?.into_os_string(),
        ),
        ("JOUZU_LAUNCHER_BASH", bash.into_os_string()),
        ("JOUZU_NO_UPDATE", "1".into()),
        ("PI_SKIP_VERSION_CHECK", "1".into()),
        ("JOUZU_TEXTGUARD_DESKTOP", "1".into()),
    ] {
        environment.insert(name.into(), (name.into(), value));
    }
    let args = vec![
        crate::node_path::node_path(&slot.join("bootstrap.mjs")).into_os_string(),
        "--mode".into(),
        "rpc".into(),
    ];
    let mut process = crate::chat_process::ChatProcess::spawn(
        &crate::runtime_install::node_executable(&root),
        &args,
        &cwd,
        &environment.into_values().collect::<Vec<_>>(),
        lease,
    )
    .map_err(|e| format!("Could not start chat: {e}"))?;
    let diagnostic_root = managed.clone();
    let diagnostic_key = session_key.clone();
    crate::logs::append(
        &diagnostic_root,
        "runtime.log",
        &format!("start key={diagnostic_key} cwd={}", cwd.display()),
    );
    static NEXT_HANDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let handle = format!(
        "chat-{}",
        NEXT_HANDLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (input, receive) = mpsc::sync_channel::<Vec<u8>>(8);
    let (stop, stopping) = mpsc::channel();
    let output = Arc::new(Mutex::new(Output::default()));
    let worker_output = output.clone();
    let worker = std::thread::spawn(move || {
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        let mut buffer = [0u8; 16384];
        let mut pending: Option<(Vec<u8>, usize, Instant)> = None;
        let mut failure = None;
        let mut drain = ExitDrain::default();
        let mut stderr_tail: Vec<u8> = Vec::new();
        let mut receive = Some(receive);
        'run: loop {
            if stopping.try_recv().is_ok() {
                break;
            }
            match process.try_wait() {
                Ok(Some(code)) => {
                    crate::logs::append(
                        &diagnostic_root,
                        "runtime.log",
                        &format!("exit key={diagnostic_key} code={code}"),
                    );
                    drain.observe_exit(code, Instant::now());
                }
                Ok(None) => {}
                Err(e) => {
                    failure = Some(e.to_string());
                    break;
                }
            }
            if !drain.accepts_input() {
                receive.take();
                pending = None;
                // The protocol defines stdin EOF as an orderly shutdown request.
                process.close_stdin();
            }
            if pending.is_none() {
                if let Some(Ok(bytes)) = receive.as_ref().map(|receiver| receiver.try_recv()) {
                    pending = Some((bytes, 0, Instant::now()));
                }
            }
            if let Some((bytes, offset, start)) = &mut pending {
                if start.elapsed() > Duration::from_secs(15) {
                    failure = Some("Runtime input stalled; outcome uncertain".into());
                    break;
                }
                match process.write_stdin(&bytes[*offset..]) {
                    Ok(count) => {
                        *offset += count;
                        if *offset == bytes.len() {
                            pending = None;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => match process.try_wait() {
                        Ok(Some(code)) => {
                            crate::logs::append(
                                &diagnostic_root,
                                "runtime.log",
                                &format!("exit key={diagnostic_key} code={code}"),
                            );
                            drain.observe_exit(code, Instant::now());
                            receive.take();
                            pending = None;
                        }
                        _ => {
                            failure = Some(format!("Runtime input failed: {e}"));
                            break;
                        }
                    },
                }
            }
            let mut overflow = false;
            let result = drain.read_stdout(
                Instant::now(),
                &mut decoder,
                |buffer| process.read_stdout(buffer),
                |record| {
                    if let Ok(mut output) = worker_output.lock() {
                        let value = Value::Object(record);
                        let size = serde_json::to_vec(&value).map_or(HARD_BYTES + 1, |v| v.len());
                        if output.bytes + size > HARD_BYTES || output.records.len() >= HARD_RECORDS {
                            overflow = true;
                            return;
                        }
                        output.bytes += size;
                        output.records.push_back(value);
                        // A slow consumer is the desktop's problem: compact the
                        // backlog and keep the turn alive.
                        compact_backlog(&mut output);
                    } else {
                        overflow = true;
                    }
                },
            );
            if let Err(error) = result {
                failure = Some(error);
                break 'run;
            }
            if overflow {
                failure = Some(
                    "The runtime stopped responding and was restarted; the transcript was kept"
                        .into(),
                );
                break 'run;
            }
            // Keep the runtime's own stderr in memory only. It is written to the log
            // when the process exits, because a healthy session must not persist
            // anything the runtime printed (diagnostics can carry credentials).
            for _ in 0..16 {
                match process.read_stderr(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        stderr_tail.extend_from_slice(&buffer[..count]);
                        let overflow = stderr_tail.len().saturating_sub(STDERR_TAIL);
                        if overflow > 0 {
                            stderr_tail.drain(..overflow);
                        }
                    }
                }
            }
            if drain.done(Instant::now()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        drain.finish(&mut decoder, &mut failure);
        let cleanup_error = process
            .stop()
            .err()
            .map(|error| format!("Runtime cleanup failed: {error}"));
        // One line per ended session. A clean stop records no stderr; an unexpected
        // end records the tail so the next occurrence can be explained.
        let stderr_text: String = String::from_utf8_lossy(&stderr_tail)
            .chars()
            .map(|character| if character.is_control() { ' ' } else { character })
            .collect();
        crate::logs::append(
            &diagnostic_root,
            "runtime.log",
            &format!(
                "end key={diagnostic_key} failure={} stderr={}",
                failure.clone().unwrap_or_default(),
                stderr_text.trim()
            ),
        );
        if let Some(error) = &cleanup_error {
            append_error(&mut failure, error.clone());
        }
        if let Ok(mut output) = worker_output.lock() {
            output.closed = true;
            output.error = failure;
            output.cleanup_error = cleanup_error;
        }
    });
    sessions.insert(
        handle.clone(),
        Session {
            owner: window.label().into(),
            generation: generation.unwrap_or_default(),
            key: session_key,
            last_poll: Instant::now(),
            input,
            stop,
            output,
            worker: Some(worker),
        },
    );
    Ok(handle)
}
#[tauri::command]
pub fn chat_send(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    handle: String,
    request: Value,
) -> Result<(), String> {
    validate(&request)?;
    let frame = encode_command(&request, 32 * 1024 * 1024).map_err(|e| e.to_string())?;
    let sessions = state.locked();
    let session = sessions
        .get(&handle)
        .filter(|s| s.owner == window.label())
        .ok_or("Unknown chat connection")?;
    session
        .input
        .try_send(frame)
        .map_err(|_| "Chat input is busy or disconnected; request was not queued".into())
}
#[tauri::command]
pub fn chat_poll(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    handle: String,
) -> Result<Poll, String> {
    let mut sessions = state.locked();
    let session = sessions
        .get_mut(&handle)
        .filter(|s| s.owner == window.label())
        .ok_or("Unknown chat connection")?;
    session.last_poll = Instant::now();
    let mut output = session
        .output
        .lock()
        .map_err(|_| "Chat output unavailable")?;
    let records = output.records.drain(..).collect();
    output.bytes = 0;
    let compacted = std::mem::take(&mut output.dropped);
    if output.closed {
        if let Ok(root) = crate::runtime::managed_root() {
            crate::logs::append(
                &root,
                "runtime.log",
                &format!(
                    "poll-closed handle={handle} error={}",
                    output.error.clone().unwrap_or_default()
                ),
            );
        }
    }
    Ok(Poll {
        records,
        closed: output.closed,
        error: output.error.clone(),
        compacted,
    })
}

#[derive(Serialize)]
pub struct PoolPoll {
    handle: String,
    records: Vec<Value>,
    closed: bool,
    error: Option<String>,
    compacted: usize,
}

/// One poll call serves every live session so the pool needs one timer.
#[tauri::command]
pub fn chat_scratch_dir() -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let directory = std::env::temp_dir().join(format!("jouzu-warm-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn chat_poll_many(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    handles: Vec<String>,
) -> Result<Vec<PoolPoll>, String> {
    let mut sessions = state.locked();
    let now = Instant::now();
    let mut polls = Vec::with_capacity(handles.len());
    for handle in &handles {
        let Some(session) = sessions.get_mut(handle) else {
            polls.push(PoolPoll { handle: handle.clone(), records: Vec::new(), closed: true, error: Some("Unknown chat connection".into()), compacted: 0 });
            continue;
        };
        if session.owner != window.label() {
            polls.push(PoolPoll { handle: handle.clone(), records: Vec::new(), closed: true, error: Some("Unknown chat connection".into()), compacted: 0 });
            continue;
        }
        session.last_poll = now;
        let mut output = session
            .output
            .lock()
            .map_err(|_| "Chat output unavailable")?;
        polls.push(PoolPoll {
            handle: handle.clone(),
            records: output.records.drain(..).collect(),
            closed: output.closed,
            error: output.error.clone(),
            compacted: std::mem::take(&mut output.dropped),
        });
        if output.closed {
            if let Ok(root) = crate::runtime::managed_root() {
                crate::logs::append(
                    &root,
                    "runtime.log",
                    &format!(
                        "poll-closed-many handle={handle} error={}",
                        output.error.clone().unwrap_or_default()
                    ),
                );
            }
        }
    }
    // A page load releases the previous generation explicitly; the reaper is the
    // backstop for a closed page that never ran its cleanup.
    let reaped: Vec<String> = reaped_handles(&sessions, window.label(), &handles, Instant::now());
    if !reaped.is_empty() {
        if let Ok(root) = crate::runtime::managed_root() {
            crate::logs::append(
                &root,
                "runtime.log",
                &format!("reap handles={}", reaped.join(",")),
            );
        }
    }
    let stopped: Vec<Session> = reaped
        .into_iter()
        .filter_map(|handle| sessions.remove(&handle))
        .collect();
    drop(sessions);
    if !stopped.is_empty() {
        std::thread::spawn(move || stop_sessions(stopped));
    }
    Ok(polls)
}

/// Stop every session created by an older page generation, keeping the current one.
#[tauri::command]
pub fn chat_release_generation(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    generation: String,
) -> Result<(), String> {
    let mut sessions = state.locked();
    let stale: Vec<String> = stale_generation_handles(&sessions, window.label(), &generation);
    let stopped: Vec<Session> = stale
        .into_iter()
        .filter_map(|handle| sessions.remove(&handle))
        .collect();
    drop(sessions);
    if !stopped.is_empty() {
        stop_sessions(stopped);
    }
    Ok(())
}

#[tauri::command]
pub fn chat_claim(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    handle: String,
    session_key: String,
) -> Result<(), String> {
    let mut sessions = state.locked();
    if sessions
        .iter()
        .any(|(other, session)| other != &handle && session.owner == window.label() && session.key == session_key)
    {
        return Err("Session is owned by another runtime".into());
    }
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| "Unknown chat connection".to_string())?;
    if session.owner != window.label() {
        return Err("Unknown chat connection".into());
    }
    session.key = session_key;
    Ok(())
}

#[tauri::command]
pub fn chat_stop_session(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    session_key: String,
) -> Result<(), String> {
    let mut sessions = state.locked();
    let handles: Vec<String> = sessions
        .iter()
        .filter(|(_, session)| session.owner == window.label() && session.key == session_key)
        .map(|(handle, _)| handle.clone())
        .collect();
    let stopped: Vec<Session> = handles
        .into_iter()
        .filter_map(|handle| sessions.remove(&handle))
        .collect();
    drop(sessions);
    if !stopped.is_empty() {
        stop_sessions(stopped);
    }
    Ok(())
}

#[tauri::command]
pub fn chat_stop_all(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
) -> Result<(), String> {
    let mut sessions = state.locked();
    let handles: Vec<String> = sessions
        .iter()
        .filter(|(_, session)| session.owner == window.label())
        .map(|(handle, _)| handle.clone())
        .collect();
    let stopped: Vec<Session> = handles
        .into_iter()
        .filter_map(|handle| sessions.remove(&handle))
        .collect();
    drop(sessions);
    if !stopped.is_empty() {
        stop_sessions(stopped);
    }
    Ok(())
}

#[tauri::command]
pub fn chat_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<ChatService>,
    handle: String,
) -> Result<(), String> {
    let mut sessions = state.locked();
    if let Some(session) = sessions.get(&handle) {
        if session.owner != window.label() {
            return Err("Unknown chat connection".into());
        }
    }
    if let Some(mut session) = sessions.remove(&handle) {
        let _ = session.stop.send(());
        join_session(&mut session)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn delta(index: usize) -> Value {
        serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": format!("chunk-{index}") } })
    }

    /// One panic must not take the whole chat service down: every later command
    /// would otherwise fail and no session could start until the app restarted.
    #[test]
    fn a_poisoned_session_map_still_serves_commands() {
        let service = ChatService { sessions: Mutex::new(HashMap::new()) };
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = service.sessions.lock().unwrap();
            panic!("poison the session map");
        }));
        std::panic::set_hook(hook);
        assert!(poisoned.is_err());
        assert!(service.sessions.is_poisoned());
        let sessions = service.locked();
        assert!(sessions.is_empty());
    }

    #[test]
    fn classification_keeps_responses_and_dialogs() {
        assert!(is_structural(&serde_json::json!({ "type": "response" })));
        assert!(is_structural(&serde_json::json!({ "type": "extension_ui_request" })));
        assert!(is_structural(&serde_json::json!({ "type": "agent_settled" })));
        assert!(!is_structural(&delta(0)));
        assert!(!is_structural(&serde_json::json!({ "type": "extension_ui_request_widget" })));
    }

    #[test]
    fn a_soft_limit_compacts_verbose_records_and_marks_one_gap() {
        let mut output = Output::default();
        output.records.push_back(serde_json::json!({ "type": "response", "id": "r1" }));
        for index in 0..(SOFT_RECORDS + 64) {
            output.records.push_back(delta(index));
        }
        output.bytes = SOFT_BYTES + 1;
        compact_backlog(&mut output);
        assert_eq!(output.records.len(), 2, "the response and one gap marker survive");
        assert_eq!(output.records[0]["type"], "response");
        assert_eq!(output.records[1]["type"], "desktop_gap");
        assert_eq!(output.dropped, SOFT_RECORDS + 64);
        // A second compaction with nothing to drop adds no marker.
        let before = output.records.len();
        compact_backlog(&mut output);
        assert_eq!(output.records.len(), before);
    }

    #[test]
    fn a_queue_under_the_soft_limit_is_left_alone() {
        let mut output = Output::default();
        output.records.push_back(delta(0));
        output.bytes = 64;
        compact_backlog(&mut output);
        assert_eq!(output.records.len(), 1);
        assert_eq!(output.dropped, 0);
    }

    #[test]
    fn exit_drain_keeps_final_records_after_would_block() {
        let now = Instant::now();
        let mut drain = ExitDrain::default();
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        drain
            .read_stdout(
                now,
                &mut decoder,
                |_| Err(std::io::ErrorKind::WouldBlock.into()),
                |_| panic!("no record"),
            )
            .unwrap();
        assert!(drain.accepts_input());
        drain.observe_exit(7, now);
        assert!(!drain.accepts_input());
        assert!(!drain.done(now));
        let mut wire = &b"{\"type\":\"response\"}\n{\"type\":\"agent_end\"}\n"[..];
        let mut records = Vec::new();
        drain
            .read_stdout(
                now,
                &mut decoder,
                |buffer| std::io::Read::read(&mut wire, buffer),
                |record| records.push(record),
            )
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(drain.done(now));
        let mut failure = None;
        drain.finish(&mut decoder, &mut failure);
        assert!(failure.unwrap().contains("Runtime exited (7)"));
    }

    #[test]
    fn exit_drain_continues_past_sixteen_chunks() {
        let now = Instant::now();
        let mut drain = ExitDrain::default();
        drain.observe_exit(0, now);
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        let wire = format!("{{\"tail\":\"{}\"}}\n", "x".repeat(20 * 16384));
        let mut wire = wire.as_bytes();
        let mut count = 0;
        drain
            .read_stdout(
                now,
                &mut decoder,
                |buffer| std::io::Read::read(&mut wire, buffer),
                |_| count += 1,
            )
            .unwrap();
        assert_eq!(count, 0);
        assert!(!drain.done(now));
        drain
            .read_stdout(
                now,
                &mut decoder,
                |buffer| std::io::Read::read(&mut wire, buffer),
                |_| count += 1,
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(drain.done(now));
    }

    #[test]
    fn eof_before_exit_preserves_status_and_reports_truncated_frame() {
        let now = Instant::now();
        let mut drain = ExitDrain::default();
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        let mut wire = &b"{\"partial\":"[..];
        drain
            .read_stdout(
                now,
                &mut decoder,
                |buffer| std::io::Read::read(&mut wire, buffer),
                |_| panic!("partial record"),
            )
            .unwrap();
        assert!(!drain.accepts_input());
        assert!(!drain.done(now));
        drain.observe_exit(9, now + Duration::from_millis(5));
        assert!(drain.done(now));
        let mut failure = None;
        drain.finish(&mut decoder, &mut failure);
        let failure = failure.unwrap();
        assert!(failure.contains("Runtime exited (9)"));
        assert!(failure.contains("ended before LF"));
    }

    #[test]
    fn inherited_stdout_and_early_eof_have_fixed_deadlines() {
        let now = Instant::now();
        let mut drain = ExitDrain::default();
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        drain.observe_exit(3, now);
        drain.observe_exit(3, now + Duration::from_secs(1));
        drain
            .read_stdout(
                now,
                &mut decoder,
                |_| Err(std::io::ErrorKind::WouldBlock.into()),
                |_| {},
            )
            .unwrap();
        assert!(!drain.done(now + EXIT_DRAIN_TIMEOUT - Duration::from_millis(1)));
        assert!(drain.done(now + EXIT_DRAIN_TIMEOUT));
        let mut failure = None;
        drain.finish(&mut decoder, &mut failure);
        let failure = failure.unwrap();
        assert!(failure.contains("Runtime exited (3)"));
        assert!(failure.contains("drain incomplete"));
        let mut drain = ExitDrain::default();
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        drain
            .read_stdout(now, &mut decoder, |_| Ok(0), |_| {})
            .unwrap();
        assert!(drain.done(now + EXIT_DRAIN_TIMEOUT));
        let mut failure = None;
        drain.finish(&mut decoder, &mut failure);
        assert!(failure
            .unwrap()
            .contains("before exit status was available"));
    }

    fn test_session() -> (Session, mpsc::Receiver<()>) {
        let (input, _) = mpsc::sync_channel(1);
        let (stop, stopping) = mpsc::channel();
        (
            Session {
                owner: "main".into(),
                generation: String::new(),
                key: String::new(),
                last_poll: Instant::now(),
                input,
                stop,
                output: Arc::new(Mutex::new(Output::default())),
                worker: None,
            },
            stopping,
        )
    }

    #[test]
    fn generation_and_reaper_pick_only_stale_handles() {
        let mut sessions = HashMap::new();
        let (mut old, _) = test_session();
        old.generation = "old".into();
        old.last_poll = Instant::now() - Duration::from_secs(120);
        let (mut live, _) = test_session();
        live.generation = "new".into();
        sessions.insert("old".into(), old);
        sessions.insert("live".into(), live);

        let mut stale = stale_generation_handles(&sessions, "main", "new");
        stale.sort();
        assert_eq!(stale, vec!["old"]);

        let mut reaped = reaped_handles(&sessions, "main", &[], Instant::now());
        reaped.sort();
        assert_eq!(reaped, vec!["old"]);
        assert!(reaped_handles(&sessions, "main", &["old".into()], Instant::now()).is_empty());
    }

    #[test]
    fn joining_reports_cleanup_failure_not_normal_exit() {
        let (mut session, _) = test_session();
        session.output.lock().unwrap().error = Some("Runtime exited (1)".into());
        assert!(join_session(&mut session).is_ok());
        let output = session.output.clone();
        session.worker = Some(std::thread::spawn(move || {
            output.lock().unwrap().cleanup_error = Some("lease retained".into());
        }));
        assert_eq!(join_session(&mut session), Err("lease retained".into()));
    }

    #[test]
    fn shutdown_signals_every_worker_before_joining() {
        let (mut first, first_stop) = test_session();
        let (second, second_stop) = test_session();
        let (observed, result) = mpsc::channel();
        first.worker = Some(std::thread::spawn(move || {
            first_stop.recv_timeout(Duration::from_secs(1)).unwrap();
            observed
                .send(second_stop.recv_timeout(Duration::from_secs(1)).is_ok())
                .unwrap();
        }));
        stop_sessions(vec![first, second]);
        assert!(result.recv().unwrap());
    }

    #[test]
    #[ignore = "requires an authenticated extracted release in JOUZU_CHAT_TEST_RUNTIME"]
    fn released_runtime_native_rpc_and_update_lease() {
        use std::ffi::OsString;
        let root = std::path::PathBuf::from(
            std::env::var_os("JOUZU_CHAT_TEST_RUNTIME").expect("release root"),
        );
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        #[cfg(windows)]
        let inherited = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH"];
        #[cfg(not(windows))]
        let inherited = ["PATH", "TMPDIR"];
        let mut env: Vec<(OsString, OsString)> = inherited
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|value| (key.into(), value)))
            .collect();
        for (key, value) in [
            ("JOUZU_HOME", home.clone()),
            ("USERPROFILE", home.clone()),
            ("HOME", home.clone()),
            ("LOCALAPPDATA", home.clone()),
            ("APPDATA", home.clone()),
            ("TEMP", dir.path().to_path_buf()),
            ("TMP", dir.path().to_path_buf()),
        ] {
            env.push((key.into(), value.into_os_string()));
        }
        #[cfg(windows)]
        env.push(("JOUZU_LAUNCHER_BASH".into(), root.join("runtime/git/bin/bash.exe").into_os_string()));
        #[cfg(not(windows))]
        env.push(("JOUZU_LAUNCHER_BASH".into(), "/bin/bash".into()));
        env.push(("JOUZU_NO_UPDATE".into(), "1".into()));
        let lease = crate::update_lock::lock(dir.path(), false).unwrap();
        let mut process = crate::chat_process::ChatProcess::spawn(
            &crate::runtime_install::node_executable(&root),
            &[
                root.join("app/bootstrap.mjs").into_os_string(),
                "--mode".into(),
                "rpc".into(),
            ],
            dir.path(),
            &env,
            lease,
        )
        .unwrap();
        assert!(crate::update_lock::lock(dir.path(), true).is_err());
        let frame = encode_command(
            &serde_json::json!({"type":"get_state","id":"native-smoke"}),
            1024,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut offset = 0;
        let mut decoder = JsonlDecoder::new(MAX_FRAME);
        let mut found = false;
        let mut buffer = [0; 8192];
        while !found {
            assert!(
                Instant::now() < deadline,
                "released RPC handshake timed out"
            );
            if offset < frame.len() {
                match process.write_stdin(&frame[offset..]) {
                    Ok(n) => offset += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => panic!("{e}"),
                }
            }
            match process.read_stdout(&mut buffer) {
                Ok(0) => panic!("released runtime closed stdout before handshake"),
                Ok(n) => decoder
                    .feed(&buffer[..n], |record| {
                        if record.get("id").and_then(Value::as_str) == Some("native-smoke") {
                            assert_eq!(record.get("success"), Some(&Value::Bool(true)));
                            found = true;
                        }
                    })
                    .unwrap(),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => panic!("{e}"),
            }
            let _ = process.read_stderr(&mut buffer);
            std::thread::sleep(Duration::from_millis(5));
        }
        process.stop().unwrap();
        assert!(crate::update_lock::lock(dir.path(), true).is_ok());
    }
    #[test]
    fn environment_filter_drops_windows_drive_pseudo_variables() {
        assert!(usable_environment_name(std::ffi::OsStr::new("PATH")));
        assert!(usable_environment_name(std::ffi::OsStr::new("JOUZU_HOME")));
        assert!(!usable_environment_name(std::ffi::OsStr::new("=C:")));
        assert!(!usable_environment_name(std::ffi::OsStr::new("")));
        assert!(!usable_environment_name(std::ffi::OsStr::new("A=B")));
    }
    #[test]
    fn image_payloads_are_typed_and_bounded() {
        let image = serde_json::json!({"type":"image","mimeType":"image/png","data":"aGVsbG8="});
        let prompt = |images: Value| serde_json::json!({"type":"prompt","id":"image","message":"Inspect","images":images});
        assert!(validate(&prompt(serde_json::json!([image.clone()]))).is_ok());
        assert!(validate(&prompt(serde_json::json!(vec![image.clone(); 5]))).is_err());
        for data in ["", "abc", "a===", "a b=", "abcd====", "éé"] {
            let mut invalid = image.clone();
            invalid["data"] = data.into();
            assert!(validate(&prompt(serde_json::json!([invalid]))).is_err());
        }
        let mut oversized = image.clone();
        oversized["data"] = "AAAA".repeat(4_000_000).into();
        assert!(validate(&prompt(serde_json::json!([oversized]))).is_err());
        let mut ordinary = image.clone();
        ordinary["data"] = "AAAA".repeat(700_000).into();
        assert!(validate(&prompt(serde_json::json!([ordinary]))).is_ok());
        let mut invalid = image;
        invalid["mimeType"] = "image/svg+xml".into();
        assert!(validate(&prompt(serde_json::json!([invalid]))).is_err());
    }
    #[test]
    fn session_switch_requires_explicit_absolute_path() {
        for path in ["relative.jsonl", "", "bad\0path"] {
            assert!(validate(
                &serde_json::json!({"type":"switch_session","id":"s","sessionPath":path})
            )
            .is_err());
        }
        let path = std::env::temp_dir().join("session.jsonl");
        assert!(validate(
            &serde_json::json!({"type":"switch_session","id":"s","sessionPath":path})
        )
        .is_ok());
    }
    #[test]
    fn compaction_and_export_validate_paths() {
        assert!(validate(&serde_json::json!({"type":"compact","id":"c"})).is_ok());
        for path in ["relative.html", "", "bad\0path"] {
            assert!(validate(
                &serde_json::json!({"type":"export_html","id":"e","outputPath":path})
            )
            .is_err());
        }
        let path = std::env::temp_dir().join("conversation.html");
        assert!(validate(
            &serde_json::json!({"type":"export_html","id":"e","outputPath":path})
        )
        .is_ok());
        assert!(validate(
            &serde_json::json!({"type":"export_html","id":"e","outputPath":"C:\\chat.html","extra":true})
        )
        .is_err());
    }
    #[test]
    fn request_boundary_rejects_unknown_fields_and_commands() {
        for value in [
            serde_json::json!({"type":"bash","id":"1","command":"echo unsafe"}),
            serde_json::json!({"type":"prompt","id":"1","message":"ok","cwd":"elsewhere"}),
            serde_json::json!({"type":"prompt","id":"1","message":""}),
            serde_json::json!({"type":"abort"}),
        ] {
            assert!(validate(&value).is_err());
        }
        assert!(validate(&serde_json::json!({"type":"prompt","id":"1","message":"hi"})).is_ok());
        assert!(validate(&serde_json::json!({"type":"get_session_stats","id":"1"})).is_ok());
        assert!(validate(&serde_json::json!({"type":"get_fork_messages","id":"1"})).is_ok());
        assert!(validate(&serde_json::json!({"type":"fork","id":"1","entryId":"entry-a"})).is_ok());
        assert!(validate(&serde_json::json!({"type":"fork","id":"1","entryId":"entry-a","extra":true})).is_err());
        assert!(validate(
            &serde_json::json!({"type":"extension_ui_response","id":"a","cancelled":true})
        )
        .is_ok());
    }
}




