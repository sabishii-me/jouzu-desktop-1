//! Session ownership for the host. One pi RPC runtime process per session, a
//! bounded event log, and an exclusive lifecycle independent of any page.

use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::log;

#[cfg(windows)]
use crate::runtime_process::ChatProcess;

pub const DEFAULT_REPLAY_LIMIT: usize = 5_000;
const MAX_TEXT_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct RuntimeSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl RuntimeSpec {
    /// The provisioned runtime rooted at the managed directory.
    pub fn from_managed(managed: &Path) -> Option<Self> {
        let node = std::env::var_os("JOUZU_HOST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| managed.join("runtime").join("node").join("node.exe"));
        let bootstrap = managed.join("app").join("bootstrap.mjs");
        if !node.is_file() || !bootstrap.is_file() {
            return None;
        }
        Some(Self {
            program: node,
            args: vec![
                bootstrap.to_string_lossy().into_owned(),
                "--mode".to_string(),
                "rpc".to_string(),
            ],
            env: Vec::new(),
        })
    }

    pub fn node_script(script: &Path) -> Self {
        Self {
            program: find_program("node.exe").unwrap_or_else(|| PathBuf::from("node")),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
        }
    }
}

pub struct SessionConfig {
    pub spec: RuntimeSpec,
    pub home: PathBuf,
    pub runtime_home: PathBuf,
    pub bash: Option<PathBuf>,
    pub replay_limit: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Starting,
    Idle,
    Running,
    Stopped,
    Error,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Starting => "starting",
            Status::Idle => "idle",
            Status::Running => "running",
            Status::Stopped => "stopped",
            Status::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionEvent {
    pub id: u64,
    pub event: String,
    pub data: Value,
}

#[derive(Default)]
struct EventLog {
    next: u64,
    events: VecDeque<SessionEvent>,
    limit: usize,
}

impl EventLog {
    fn new(limit: usize) -> Self {
        Self {
            next: 1,
            events: VecDeque::new(),
            limit: limit.max(1),
        }
    }

    fn push(&mut self, session_id: &str, event: &str, mut data: Value) -> SessionEvent {
        let id = self.next;
        self.next += 1;
        if let Some(object) = data.as_object_mut() {
            object.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        let stored = SessionEvent {
            id,
            event: event.to_string(),
            data,
        };
        self.events.push_back(stored.clone());
        while self.events.len() > self.limit {
            self.events.pop_front();
        }
        stored
    }

    fn last_id(&self) -> u64 {
        self.next.saturating_sub(1)
    }

    fn oldest_id(&self) -> Option<u64> {
        self.events.front().map(|event| event.id)
    }

    fn after(&self, after: u64) -> Vec<SessionEvent> {
        self.events
            .iter()
            .filter(|event| event.id > after)
            .cloned()
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Handshake {
    Switch,
    Messages,
    Ready,
}

struct SentMessage {
    message_id: String,
    text: String,
}

pub struct Session {
    pub id: String,
    pub workspace_path: String,
    pub session_path: Option<String>,
    pub key: String,
    status: Mutex<Status>,
    events: Mutex<EventLog>,
    tx: broadcast::Sender<SessionEvent>,
    process: Arc<Mutex<ChatProcess>>,
    lease_path: PathBuf,
    messages: Mutex<HashMap<String, SentMessage>>,
    next_message: AtomicU64,
    next_request: AtomicU64,
    active_message: Mutex<Option<String>>,
    handshake: Mutex<Handshake>,
    home: PathBuf,
}

impl Session {
    pub fn status(&self) -> Status {
        *self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn cursor(&self) -> u64 {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last_id()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.tx.subscribe()
    }

    pub fn snapshot_event(&self) -> SessionEvent {
        let cursor = self.cursor();
        SessionEvent {
            id: cursor,
            event: "session.snapshot".to_string(),
            data: json!({
                "sessionId": self.id,
                "status": self.status().as_str(),
                "cursor": cursor,
                "workspacePath": self.workspace_path,
                "sessionPath": self.session_path,
                "pendingApprovals": [],
                "pendingQuestions": [],
            }),
        }
    }

    pub fn events_after(&self, after: u64) -> (Vec<SessionEvent>, u64) {
        let log = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let oldest = log.oldest_id();
        let stale = after == 0
            || oldest.is_none()
            || after > log.last_id()
            || oldest.is_some_and(|oldest| after < oldest.saturating_sub(1));
        if stale {
            drop(log);
            let snapshot = self.snapshot_event();
            let cursor = snapshot.id;
            return (vec![snapshot], cursor);
        }
        let events = log.after(after);
        let cursor = events.last().map(|event| event.id).unwrap_or(after);
        (events, cursor)
    }

    fn publish(&self, event: &str, data: Value) -> SessionEvent {
        let stored = {
            let mut log_guard = self
                .events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            log_guard.push(&self.id, event, data)
        };
        let _ = self.tx.send(stored.clone());
        stored
    }

    fn set_status(&self, status: Status) {
        let changed = {
            let mut guard = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *guard == status {
                false
            } else {
                *guard = status;
                true
            }
        };
        if changed {
            self.publish("session.status", json!({ "status": status.as_str() }));
        }
    }

    fn request_id(&self) -> String {
        format!(
            "r-{}",
            self.next_request.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    fn write_command(&self, value: Value) -> Result<(), ApiError> {
        let line = format!("{}\n", value);
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut offset = 0;
        let bytes = line.as_bytes();
        while offset < bytes.len() {
            match process.write_stdin(&bytes[offset..]) {
                Ok(0) => return Err(ApiError::unavailable("runtime input is closed")),
                Ok(count) => offset += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(_) => return Err(ApiError::unavailable("runtime input is closed")),
            }
        }
        Ok(())
    }

    fn request_messages(&self) {
        let id = self.request_id();
        if let Err(error) = self.write_command(json!({ "id": id, "type": "get_messages" })) {
            self.publish(
                "error",
                json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
            );
            self.set_status(Status::Error);
        }
    }

    fn start_handshake(&self) {
        match &self.session_path {
            Some(path) => {
                let id = self.request_id();
                let result = self.write_command(json!({
                    "id": id,
                    "type": "switch_session",
                    "sessionPath": path,
                }));
                if let Err(error) = result {
                    self.publish(
                        "error",
                        json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
                    );
                    self.set_status(Status::Error);
                    return;
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Switch;
            }
            None => {
                self.request_messages();
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
            }
        }
    }

    fn handle_response(&self, value: &Value) {
        let command = value.get("command").and_then(Value::as_str).unwrap_or("");
        let success = value
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !success {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("runtime request failed");
            log(
                &self.home,
                "warn",
                "runtime.response_failed",
                json!({ "command": command, "message": message }),
            );
            self.publish(
                "error",
                json!({ "code": "runtime-error", "message": message, "retryable": false }),
            );
            self.set_status(Status::Error);
            return;
        }
        match command {
            "switch_session" => {
                let cancelled = value
                    .get("data")
                    .and_then(|data| data.get("cancelled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if cancelled {
                    self.publish(
                        "error",
                        json!({ "code": "session-switch-cancelled", "message": "The runtime cancelled the session switch", "retryable": false }),
                    );
                    self.set_status(Status::Error);
                    return;
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
                self.request_messages();
            }
            "get_messages" => {
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Ready;
                if matches!(self.status(), Status::Starting) {
                    self.set_status(Status::Idle);
                }
            }
            _ => {}
        }
    }

    fn handle_runtime_line(&self, value: Value) {
        match value.get("type").and_then(Value::as_str) {
            Some("response") => self.handle_response(&value),
            Some("agent_start") => self.set_status(Status::Running),
            Some("message_update") => {
                let Some(update) = value
                    .get("assistantMessageEvent")
                    .and_then(Value::as_object)
                else {
                    return;
                };
                let Some(kind) = update.get("type").and_then(Value::as_str) else {
                    return;
                };
                let active = self
                    .active_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                let Some(message_id) = active else {
                    return;
                };
                match kind {
                    "text_delta" => {
                        let text = update.get("delta").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            self.publish(
                                "message.delta",
                                json!({ "messageId": message_id, "text": text }),
                            );
                        }
                    }
                    "thinking_delta" => {
                        let text = update.get("delta").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            self.publish(
                                "message.delta",
                                json!({ "messageId": message_id, "text": text, "kind": "thinking" }),
                            );
                        }
                    }
                    _ => {}
                }
            }
            Some("tool_execution_start") => {
                self.publish(
                    "tool.start",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "toolName": value.get("toolName"),
                        "args": value.get("args"),
                    }),
                );
            }
            Some("tool_execution_update") => {
                self.publish(
                    "tool.update",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "partialResult": value.get("partialResult"),
                    }),
                );
            }
            Some("tool_execution_end") => {
                self.publish(
                    "tool.result",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "ok": value.get("isError").and_then(Value::as_bool) != Some(true),
                        "result": value.get("result"),
                    }),
                );
            }
            Some("agent_settled") => {
                let aborted = value
                    .get("aborted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let active = self
                    .active_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(message_id) = active {
                    let stop_reason = if aborted { "interrupted" } else { "completed" };
                    self.publish(
                        "message.done",
                        json!({ "messageId": message_id, "stopReason": stop_reason }),
                    );
                    self.publish(
                        "turn.end",
                        json!({ "turnId": message_id, "status": stop_reason }),
                    );
                }
                self.set_status(Status::Idle);
            }
            Some("extension_ui_request") => {
                let method = value
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                log(
                    &self.home,
                    "warn",
                    "runtime.ui_request",
                    json!({ "method": method }),
                );
            }
            Some("extension_error") => {
                let message = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("extension error");
                self.publish(
                    "error",
                    json!({ "code": "extension-error", "message": message, "retryable": false }),
                );
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("runtime error");
                self.publish(
                    "error",
                    json!({ "code": "runtime-error", "message": message, "retryable": false }),
                );
                self.set_status(Status::Error);
            }
            _ => {}
        }
    }

    pub fn send(&self, client_message_id: &str, text: &str) -> Result<Value, ApiError> {
        if client_message_id.is_empty() || client_message_id.len() > 200 {
            return Err(ApiError::bad_request("clientMessageId is required"));
        }
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(ApiError::bad_request("text must be 1..32 KiB"));
        }
        match self.status() {
            Status::Stopped | Status::Error => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "session-stopped",
                    "Session is not runnable",
                    false,
                ))
            }
            _ => {}
        }
        let mut messages = self
            .messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = messages.get(client_message_id) {
            if existing.text != text {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "id-conflict",
                    "clientMessageId was already used with different text",
                    false,
                ));
            }
            return Ok(json!({
                "messageId": existing.message_id.clone(),
                "receipt": "queued",
            }));
        }
        if matches!(self.status(), Status::Running) {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "session-busy",
                "Wait for the current turn to settle",
                true,
            ));
        }
        let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("m-{counter}");
        *self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message_id.clone());
        self.publish(
            "message.accepted",
            json!({ "messageId": message_id.clone(), "receipt": "queued" }),
        );
        self.publish("turn.start", json!({ "turnId": message_id.clone() }));
        self.set_status(Status::Running);
        let result = self.write_command(json!({
            "id": message_id.clone(),
            "type": "prompt",
            "message": text,
        }));
        if let Err(error) = result {
            self.publish(
                "error",
                json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
            );
            self.set_status(Status::Error);
            return Err(error);
        }
        messages.insert(
            client_message_id.to_string(),
            SentMessage {
                message_id: message_id.clone(),
                text: text.to_string(),
            },
        );
        drop(messages);
        Ok(json!({ "messageId": message_id, "receipt": "queued" }))
    }

    pub fn interrupt(&self) -> Result<(), ApiError> {
        let id = self.request_id();
        self.write_command(json!({ "id": id, "type": "abort" }))
    }

    pub fn stop(&self) {
        if matches!(self.status(), Status::Stopped) {
            return;
        }
        self.set_status(Status::Stopped);
        if let Ok(mut process) = self.process.lock() {
            process.close_stdin();
            let _ = process.stop();
        }
        let _ = std::fs::remove_file(&self.lease_path);
    }

    pub fn info(&self) -> Value {
        json!({
            "sessionId": self.id,
            "workspacePath": self.workspace_path,
            "sessionPath": self.session_path,
            "status": self.status().as_str(),
            "running": self.status() == Status::Running,
            "cursor": self.cursor(),
            "pendingApprovalCount": 0,
            "pendingQuestionCount": 0,
        })
    }

    fn spawn(
        id: String,
        workspace_path: String,
        session_path: Option<String>,
        key: String,
        config: &SessionConfig,
    ) -> Result<Arc<Session>, ApiError> {
        let workspace = PathBuf::from(&workspace_path);
        let mut environment: HashMap<String, (OsString, OsString)> = std::env::vars_os()
            .filter(|(name, _)| {
                let text = name.to_string_lossy();
                !text.is_empty() && !text.contains('=') && !text.contains('\0')
            })
            .map(|(key, value)| (key.to_string_lossy().to_ascii_uppercase(), (key, value)))
            .collect();
        for name in ["NODE_OPTIONS", "NODE_PATH"] {
            environment.remove(name);
        }
        let mut set = |name: &str, value: OsString| {
            environment.insert(name.to_ascii_uppercase(), (OsString::from(name), value));
        };
        set("JOUZU_HOME", config.runtime_home.as_os_str().to_os_string());
        set("JOUZU_NO_UPDATE", OsString::from("1"));
        set("PI_SKIP_VERSION_CHECK", OsString::from("1"));
        set("JOUZU_TEXTGUARD_DESKTOP", OsString::from("1"));
        set("JOUZU_HOST_SESSION_ID", OsString::from(&id));
        if let Some(bash) = &config.bash {
            set("JOUZU_LAUNCHER_BASH", bash.as_os_str().to_os_string());
        }
        if let Some(path) = &session_path {
            set("JOUZU_SESSION_PATH", OsString::from(path));
        }
        for (key, value) in &config.spec.env {
            set(key, OsString::from(value));
        }
        let env: Vec<(OsString, OsString)> = environment.into_values().collect();
        let lease_path = config.home.join(format!("session-{id}.lease"));
        let lease = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&lease_path)
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    format!("Could not create the runtime lease: {error}"),
                    false,
                )
            })?;
        let args: Vec<OsString> = config.spec.args.iter().map(OsString::from).collect();
        let process = ChatProcess::spawn(&config.spec.program, &args, &workspace, &env, lease)
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "runtime-unavailable",
                    format!("Could not start the runtime: {error}"),
                    false,
                )
            })?;
        let process = Arc::new(Mutex::new(process));
        let (tx, _) = broadcast::channel(1024);
        let session = Arc::new(Session {
            id,
            workspace_path,
            session_path,
            key,
            status: Mutex::new(Status::Starting),
            events: Mutex::new(EventLog::new(config.replay_limit)),
            tx,
            process: process.clone(),
            lease_path,
            messages: Mutex::new(HashMap::new()),
            next_message: AtomicU64::new(0),
            next_request: AtomicU64::new(0),
            active_message: Mutex::new(None),
            handshake: Mutex::new(Handshake::Messages),
            home: config.home.clone(),
        });

        {
            let session = session.clone();
            let process = process.clone();
            std::thread::spawn(move || {
                let mut buffer: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let result = {
                        let mut process = process
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        process.read_stdout(&mut chunk)
                    };
                    match result {
                        Ok(0) => {
                            if exited(&process) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Ok(count) => {
                            buffer.extend_from_slice(&chunk[..count]);
                            while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                                let line: Vec<u8> = buffer.drain(..=index).collect();
                                let text = String::from_utf8_lossy(&line);
                                let text = text.trim_end_matches(['\r', '\n']);
                                if text.is_empty() {
                                    continue;
                                }
                                if let Ok(value) = serde_json::from_str::<Value>(text) {
                                    session.handle_runtime_line(value);
                                }
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        {
            let process = process.clone();
            let home = config.home.clone();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                loop {
                    let result = {
                        let mut process = process
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        process.read_stderr(&mut chunk)
                    };
                    match result {
                        Ok(0) => {
                            if exited(&process) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Ok(count) => {
                            let line = String::from_utf8_lossy(&chunk[..count]).trim().to_string();
                            if !line.is_empty() {
                                log(&home, "debug", "runtime.stderr", json!({ "line": line }));
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        {
            let session = session.clone();
            let process = process.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(50));
                let exited = {
                    let mut process = process
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    matches!(process.try_wait(), Ok(Some(_)))
                };
                if exited {
                    if !matches!(session.status(), Status::Stopped) {
                        session.set_status(Status::Stopped);
                    }
                    break;
                }
            });
        }
        session.start_handshake();
        Ok(session)
    }
}

fn exited(process: &Arc<Mutex<ChatProcess>>) -> bool {
    let mut process = process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    matches!(process.try_wait(), Ok(Some(_)))
}

pub struct SessionManager {
    config: Option<SessionConfig>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionManager {
    pub fn new(
        spec: Option<RuntimeSpec>,
        home: PathBuf,
        runtime_home: PathBuf,
        bash: Option<PathBuf>,
        replay_limit: usize,
    ) -> Self {
        let config = spec.map(|spec| SessionConfig {
            spec,
            home,
            runtime_home,
            bash,
            replay_limit,
        });
        Self {
            config,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<Value> {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut values: Vec<Value> = sessions.values().map(|session| session.info()).collect();
        values.sort_by(|a, b| {
            a.get("sessionId")
                .and_then(Value::as_str)
                .cmp(&b.get("sessionId").and_then(Value::as_str))
        });
        values
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    pub fn create(
        &self,
        workspace: &str,
        session_path: Option<String>,
        key: Option<String>,
    ) -> Result<Arc<Session>, ApiError> {
        let workspace = std::fs::canonicalize(workspace)
            .map_err(|_| ApiError::bad_request("workspacePath is unavailable"))?;
        if !workspace.is_dir() {
            return Err(ApiError::bad_request("workspacePath must be a folder"));
        }
        let key = key.unwrap_or_else(|| {
            session_path
                .clone()
                .unwrap_or_else(|| workspace.to_string_lossy().into_owned())
        });
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = sessions
            .values()
            .find(|session| session.key == key)
            .cloned()
        {
            if !matches!(existing.status(), Status::Stopped) {
                return Ok(existing);
            }
            sessions.remove(&existing.id);
        }
        let config = self.config.as_ref().ok_or_else(|| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime-unavailable",
                "No runtime is configured for the host",
                false,
            )
        })?;
        std::fs::create_dir_all(&config.home.join("data")).ok();
        let id = format!("h-{}", random_id());
        let session = Session::spawn(
            id,
            workspace.to_string_lossy().into_owned(),
            session_path,
            key.clone(),
            config,
        )?;
        sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub fn stop_all(&self) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for session in sessions {
            session.stop();
        }
    }
}

/// Git Bash discovery for the runtime environment.
pub fn find_bash(managed: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("JOUZU_LAUNCHER_BASH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let candidates = [
        managed.join("runtime/git/installed/bin/bash.exe"),
        managed.join("runtime/git/PortableGit/bin/bash.exe"),
        managed.join("runtime/git/bin/bash.exe"),
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    #[serde(rename = "workspacePath")]
    pub workspace_path: String,
    #[serde(rename = "sessionPath")]
    pub session_path: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    pub text: String,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: axum::http::StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    pub fn new(
        status: axum::http::StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid-request",
            message,
            false,
        )
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "runtime-unavailable",
            message,
            true,
        )
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            axum::Json(json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "retryable": self.retryable,
                }
            })),
        )
            .into_response()
    }
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}
