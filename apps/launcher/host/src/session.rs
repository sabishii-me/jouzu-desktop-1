//! Session ownership for the host. One runtime process per session, a bounded
//! event log, and an exclusive lifecycle independent of any page.

use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
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

pub const DEFAULT_REPLAY_LIMIT: usize = 5_000;
const MAX_TEXT_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct RuntimeSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl RuntimeSpec {
    /// The provisioned runtime, when the managed root has one.
    pub fn from_managed(home: &Path) -> Option<Self> {
        let node = std::env::var_os("JOUZU_HOST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("runtime").join("node").join("node.exe"));
        let bootstrap = home.join("app").join("bootstrap.mjs");
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
            program: PathBuf::from("node"),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
        }
    }
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
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Option<Child>>>,
    #[cfg(windows)]
    job: Option<Job>,
    messages: Mutex<HashMap<String, SentMessage>>,
    next_message: AtomicU64,
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

    /// Snapshot on an initial attach or when the cursor is older than the log.
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

    fn handle_runtime_line(&self, value: Value) {
        match value.get("type").and_then(Value::as_str) {
            Some("ready") => self.set_status(Status::Idle),
            Some("delta") => {
                let message_id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let text = value.get("text").and_then(Value::as_str).unwrap_or("");
                self.set_status(Status::Running);
                self.publish(
                    "message.delta",
                    json!({ "messageId": message_id, "text": text }),
                );
            }
            Some("done") => {
                let message_id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let stop_reason = value
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                self.publish(
                    "message.done",
                    json!({ "messageId": message_id, "stopReason": stop_reason }),
                );
                self.publish(
                    "turn.end",
                    json!({ "turnId": message_id, "status": stop_reason }),
                );
                self.set_status(Status::Idle);
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
                "messageId": existing.message_id,
                "receipt": "queued",
            }));
        }
        let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("m-{counter}");
        let frame = json!({ "type": "prompt", "id": message_id, "text": text });
        let line = format!("{frame}\n");
        let mut stdin = self
            .stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(input) = stdin.as_mut() else {
            return Err(ApiError::unavailable("runtime input is closed"));
        };
        if input.write_all(line.as_bytes()).is_err() {
            return Err(ApiError::unavailable("runtime input is closed"));
        }
        if input.flush().is_err() {
            return Err(ApiError::unavailable("runtime input is closed"));
        }
        messages.insert(
            client_message_id.to_string(),
            SentMessage {
                message_id: message_id.clone(),
                text: text.to_string(),
            },
        );
        drop(stdin);
        self.publish(
            "message.accepted",
            json!({ "messageId": message_id, "receipt": "queued" }),
        );
        self.publish("turn.start", json!({ "turnId": message_id }));
        self.set_status(Status::Running);
        Ok(json!({ "messageId": message_id, "receipt": "queued" }))
    }

    pub fn interrupt(&self) -> Result<(), ApiError> {
        self.write_command(json!({ "type": "interrupt" }))
    }

    pub fn stop(&self) {
        if matches!(self.status(), Status::Stopped) {
            return;
        }
        self.set_status(Status::Stopped);
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }

    fn write_command(&self, value: Value) -> Result<(), ApiError> {
        let mut stdin = self
            .stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(input) = stdin.as_mut() else {
            return Err(ApiError::unavailable("runtime input is closed"));
        };
        let line = format!("{value}\n");
        input
            .write_all(line.as_bytes())
            .map_err(|_| ApiError::unavailable("runtime input is closed"))?;
        input
            .flush()
            .map_err(|_| ApiError::unavailable("runtime input is closed"))
    }
}

pub struct SessionManager {
    spec: Option<RuntimeSpec>,
    home: PathBuf,
    replay_limit: usize,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionManager {
    pub fn new(spec: Option<RuntimeSpec>, home: PathBuf, replay_limit: usize) -> Self {
        Self {
            spec,
            home,
            replay_limit,
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
        let spec = self.spec.clone().ok_or_else(|| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime-unavailable",
                "No runtime is configured for the host",
                false,
            )
        })?;
        std::fs::create_dir_all(self.home.join("data")).ok();
        let id = format!("h-{}", random_id());
        let session = Session::spawn(
            id,
            workspace.to_string_lossy().into_owned(),
            session_path,
            key.clone(),
            spec,
            self.home.clone(),
            self.replay_limit,
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

impl Session {
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

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        id: String,
        workspace_path: String,
        session_path: Option<String>,
        key: String,
        spec: RuntimeSpec,
        home: PathBuf,
        replay_limit: usize,
    ) -> Result<Arc<Session>, ApiError> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("JOUZU_HOME", home.join("data"))
            .env("JOUZU_HOST_SESSION_ID", &id)
            .env("JOUZU_NO_UPDATE", "1")
            .envs(spec.env.iter().cloned())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        if let Some(session_path) = &session_path {
            command.env("JOUZU_SESSION_PATH", session_path);
        }
        let mut child = command.spawn().map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime-unavailable",
                format!("Could not start the runtime: {error}"),
                false,
            )
        })?;
        #[cfg(windows)]
        let job = match Job::create().and_then(|job| job.assign(&child).map(|_| job)) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = child.kill();
                return Err(ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    format!("Could not create the runtime job: {error}"),
                    false,
                ));
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(Some(child)));
        let (tx, _) = broadcast::channel(1024);
        let session = Arc::new(Session {
            id,
            workspace_path,
            session_path,
            key,
            status: Mutex::new(Status::Starting),
            events: Mutex::new(EventLog::new(replay_limit)),
            tx,
            stdin: Mutex::new(stdin),
            child: child.clone(),
            #[cfg(windows)]
            job,
            messages: Mutex::new(HashMap::new()),
            next_message: AtomicU64::new(0),
        });

        if let Some(stdout) = stdout {
            let session = session.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    session.handle_runtime_line(value);
                }
            });
        }
        if let Some(stderr) = stderr {
            let home = home.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    log(&home, "debug", "runtime.stderr", json!({ "line": line }));
                }
            });
        }

        let waiter_child = child;
        let waiter_session = session.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            let exited = {
                let mut guard = waiter_child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) => {
                            guard.take();
                            true
                        }
                        Ok(None) => false,
                        Err(_) => {
                            guard.take();
                            true
                        }
                    },
                    None => true,
                }
            };
            if exited {
                if !matches!(waiter_session.status(), Status::Stopped) {
                    waiter_session.set_status(Status::Stopped);
                }
                break;
            }
        });

        Ok(session)
    }
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

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::CONFLICT, "sessions", message, false)
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

#[cfg(windows)]
struct Job(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn create() -> std::io::Result<Self> {
        use std::mem::size_of;
        use windows::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let handle = windows::Win32::System::JobObjects::CreateJobObjectW(
                None,
                windows::core::PCWSTR::null(),
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            Ok(Self(handle))
        }
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle()))
                .map_err(|error| std::io::Error::other(error.to_string()))
        }
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
