//! The Assistant: Desktop's project coordinator (experimental).
//!
//! The Assistant is a jouzu session with its own configuration, not the coder's:
//! the host starts a jouzu runtime for it the way it starts one for any session
//! (same program, same environment, same process job), with the Assistant's
//! prompt, its skills, only its tools plus read-only ones, no project context
//! files, no MCP servers, and Flow and TextGuard off. Its models and sign-ins
//! are jouzu's: whatever Settings lists, the Assistant can run on.
//!
//! Its tools live here, in the host, and run as the built-in client
//! `assistant`. The runtime reaches them through the jouzu-assistant extension,
//! which calls the host's bridge with a token made for that runtime alone.
//!
//! Turns are decoupled from events. A user message is delivered as soon as
//! the Assistant is idle. Task changes wake it as soon as it is idle, with a
//! short summary; it reads and acknowledges the details itself. Changes that
//! arrive while it works are one wake when it is done. Nothing waits on a
//! timer and nothing is polled: the loop runs when something happens.
//!
//! Nothing restarts it silently: if the runtime ends, it stays stopped until
//! the user sends a message or turns it on again.

use std::{
    collections::VecDeque,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{
    extract::State as Extract,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::{
    mcp::{self, AgentClient},
    projects::{Project, ProjectStore},
    runtime::{
        adapter::pi::{self, command, Record},
        RuntimeEvent, RuntimeSupervisor, SpawnSpec,
    },
    session::{ApiError, RuntimeSpec, SessionManager},
    tasks::TaskManager,
};

pub const CLIENT: &str = "assistant";
/// The extension that gives the Assistant's runtime its tools. Written beside
/// the Assistant's files and passed by path: no other session loads it.
const EXTENSION: [(&str, &str); 2] = [
    ("package.json", include_str!("../../../../packaging/desktop/extensions/jouzu-assistant/package.json")),
    ("index.js", include_str!("../../../../packaging/desktop/extensions/jouzu-assistant/index.js")),
];
/// The runtime's own tools the Assistant has besides its own: reading only.
const READ_TOOLS: [&str; 4] = ["read", "grep", "find", "ls"];
/// jouzu's own options (read before Pi's): TextGuard is for the coder's work.
const JOUZU_OPTIONS: [&str; 1] = ["--jouzu-textguard-off"];
/// The runtime's session the Assistant continues across restarts.
const SESSION_ID: &str = "assistant";
/// A command's answer when the runtime ended: its end, with the reason, is
/// reported by the event loop.
const RUNTIME_ENDED: &str = "The Assistant's runtime ended";
/// How long a starting runtime may take to answer (Node and extensions loading).
const PROMPT: &str = include_str!("../../../../packaging/desktop/assistant/prompt.md");
pub const SKILLS: &[(&str, &str)] = &[
    ("write-a-brief", include_str!("../../../../packaging/desktop/assistant/skills/write-a-brief.md")),
    ("break-down-work", include_str!("../../../../packaging/desktop/assistant/skills/break-down-work.md")),
    ("follow-up", include_str!("../../../../packaging/desktop/assistant/skills/follow-up.md")),
    ("accept-with-evidence", include_str!("../../../../packaging/desktop/assistant/skills/accept-with-evidence.md")),
    ("work-an-issue", include_str!("../../../../packaging/desktop/assistant/skills/work-an-issue.md")),
    ("draw-task-views", include_str!("../../../../packaging/desktop/assistant/skills/draw-task-views.md")),
    ("configure-workflow", include_str!("../../../../packaging/desktop/assistant/skills/configure-workflow.md")),
    ("keep-memory", include_str!("../../../../packaging/desktop/assistant/skills/keep-memory.md")),
    ("catch-requests", include_str!("../../../../packaging/desktop/assistant/skills/catch-requests.md")),
];

const MEMORY_TYPES: [&str; 5] = ["user", "feedback", "project", "decision", "reference"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelPick {
    pub provider: String,
    pub id: String,
    /// Reasoning effort as jouzu names it (off … max); absent: the model's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    model: Option<ModelPick>,
}

/// Where things are. Tests point these at fixtures.
#[derive(Clone, Default)]
pub struct AssistantPaths {
    /// A program to run instead of the runtime sessions use (tests). The
    /// environment is the sessions' either way.
    pub runtime: Option<RuntimeSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Off,
    Starting,
    Idle,
    Running,
    Stopped,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Off => "off",
            Phase::Starting => "starting",
            Phase::Idle => "idle",
            Phase::Running => "running",
            Phase::Stopped => "stopped",
        }
    }
}

struct Wake {
    at: Instant,
    note: String,
}

/// Scheduled wakes on disk, by wall-clock time, so a restart keeps them: the
/// Assistant may already have told the user a reminder is set.
fn load_wakes(dir: &Path) -> Vec<Wake> {
    let now_ms = Utc::now().timestamp_millis();
    std::fs::read(dir.join("wakes.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|wake| {
            let due = wake["dueMs"].as_i64()?;
            let left = Duration::from_millis(due.saturating_sub(now_ms).max(0) as u64);
            Some(Wake { at: Instant::now() + left, note: wake["note"].as_str().unwrap_or("").to_string() })
        })
        .collect()
}

fn save_wakes(dir: &Path, wakes: &[Wake]) {
    let now = Instant::now();
    let now_ms = Utc::now().timestamp_millis();
    let rows: Vec<Value> = wakes
        .iter()
        .map(|wake| json!({ "dueMs": now_ms + wake.at.saturating_duration_since(now).as_millis() as i64, "note": wake.note }))
        .collect();
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join("wakes.json"), serde_json::to_vec(&rows).unwrap_or_default());
}

struct State {
    phase: Phase,
    error: Option<String>,
    /// User messages waiting for the Assistant to be idle.
    queue: VecDeque<String>,
    /// Inbox seq the last wake covered.
    woken_seq: u64,
    scheduled: Vec<Wake>,
    turn: u64,
    /// The memory index as the Assistant last saw it.
    memory_seen: String,
}

/// The Assistant's runtime while it lives.
struct Runtime {
    supervisor: Arc<RuntimeSupervisor>,
    /// Opens the bridge for this runtime only.
    token: String,
}

pub struct Assistant {
    dir: PathBuf,
    paths: AssistantPaths,
    sessions: Arc<SessionManager>,
    tasks: Arc<TaskManager>,
    projects: Arc<ProjectStore>,
    settings: Mutex<Settings>,
    state: Mutex<State>,
    runtime: Mutex<Option<Runtime>>,
    kick: Notify,
    /// Bumped each start, so a reader of an old runtime ignores its end.
    generation: std::sync::atomic::AtomicU64,
    /// Where the host listens, for the bridge (set once the host is bound).
    port: OnceLock<u16>,
}


fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn cut(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn io(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(error.to_string())
}

impl Assistant {
    pub fn new(
        home: &Path,
        paths: AssistantPaths,
        sessions: Arc<SessionManager>,
        tasks: Arc<TaskManager>,
        projects: Arc<ProjectStore>,
    ) -> Arc<Self> {
        let dir = home.join("assistant");
        let settings = std::fs::read(dir.join("assistant.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default();
        let scheduled = load_wakes(&dir);
        Arc::new(Self {
            dir,
            paths,
            sessions,
            tasks,
            projects,
            settings: Mutex::new(settings),
            state: Mutex::new(State {
                phase: Phase::Off,
                error: None,
                queue: VecDeque::new(),
                woken_seq: 0,
                scheduled,
                turn: 0,
                memory_seen: String::new(),
            }),
            runtime: Mutex::new(None),
            kick: Notify::new(),
            generation: std::sync::atomic::AtomicU64::new(0),
            port: OnceLock::new(),
        })
    }

    /// The paths a real host uses: the runtime every session runs on.
    pub fn default_paths(_home: &Path, _sessions: &SessionManager) -> AssistantPaths {
        AssistantPaths::default()
    }

    /// Where the host listens. The bridge is on the host's own listener.
    pub fn set_port(&self, port: u16) {
        let _ = self.port.set(port);
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_phase(&self, phase: Phase, error: Option<String>) {
        let mut state = self.state();
        state.phase = phase;
        state.error = error.clone();
        drop(state);
        self.sessions.publish_control("assistant.changed", json!({ "phase": phase.as_str(), "error": error }));
        self.kick.notify_one();
    }

    fn memory_dir(&self) -> PathBuf {
        self.dir.join("memory")
    }

    fn transcript(&self) -> PathBuf {
        self.dir.join("transcript.jsonl")
    }

    /// Adds a row to the transcript. Each row has a fixed id (`m<line>`), by
    /// which a project keeps the person's words it was asked with.
    fn record(&self, kind: &str, text: &str) -> Value {
        let _ = std::fs::create_dir_all(&self.dir);
        let line = std::fs::read_to_string(self.transcript()).map(|text| text.lines().count()).unwrap_or(0) + 1;
        let row = json!({ "id": format!("m{line}"), "at": now_iso(), "kind": kind, "text": text });
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(self.transcript()) {
            use std::io::Write;
            let _ = writeln!(file, "{row}");
        }
        self.sessions.publish_control("assistant.changed", json!({ "message": row }));
        row
    }

    /// Starts the scheduler and, when the user turned the Assistant on, the
    /// process. Called once when the host starts.
    pub fn launch(self: &Arc<Self>) {
        let assistant = Arc::clone(self);
        tokio::spawn(async move { assistant.schedule_loop().await });
        if self.settings().enabled {
            let assistant = Arc::clone(self);
            tokio::spawn(async move { assistant.start().await });
        }
    }

    pub async fn snapshot(&self) -> Value {
        let settings = self.settings();
        let state = self.state();
        json!({
            "enabled": settings.enabled,
            "model": settings.model,
            "thinkingLevels": THINKING_LEVELS,
            "phase": state.phase.as_str(),
            "error": state.error,
            "queued": state.queue.len(),
            "unseen": self.unseen(),
            "scheduledWakes": state.scheduled.iter().map(|wake| json!({
                "inSeconds": wake.at.saturating_duration_since(Instant::now()).as_secs(),
                "note": wake.note,
            })).collect::<Vec<_>>(),
        })
    }

    pub async fn update(self: &Arc<Self>, enabled: Option<bool>, model: Option<Option<ModelPick>>) -> Result<Value, ApiError> {
        let (before, after) = {
            let mut settings = self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let before = settings.clone();
            let mut next = settings.clone();
            if let Some(enabled) = enabled {
                next.enabled = enabled;
            }
            if let Some(model) = model {
                next.model = model;
            }
            if let Some(thinking) = next.model.as_ref().and_then(|model| model.thinking.as_deref()) {
                if !THINKING_LEVELS.contains(&thinking) {
                    return Err(ApiError::bad_request(format!("Unknown reasoning effort: {thinking}")));
                }
            }
            // The Assistant runs only on a model the user chose: never a fallback.
            if next.enabled && next.model.is_none() {
                return Err(ApiError::bad_request("Choose a model for the Assistant"));
            }
            *settings = next;
            std::fs::create_dir_all(&self.dir).map_err(io)?;
            let bytes = serde_json::to_vec_pretty(&*settings).map_err(io)?;
            std::fs::write(self.dir.join("assistant.json"), bytes).map_err(io)?;
            (before, settings.clone())
        };
        let restart = after.enabled && (!before.enabled || before.model != after.model);
        if !after.enabled {
            self.stop_process(Phase::Off, None).await;
        } else if restart {
            self.stop_process(Phase::Off, None).await;
            let assistant = Arc::clone(self);
            tokio::spawn(async move { assistant.start().await });
        }
        Ok(self.snapshot().await)
    }

    /// Queues a message from the user. Starts the Assistant again if it had
    /// stopped: the user asked.
    pub async fn send(self: &Arc<Self>, text: &str) -> Result<Value, ApiError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(ApiError::bad_request("Enter a message"));
        }
        if !self.settings().enabled {
            return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "assistant-off", "Turn the Assistant on first", false));
        }
        let row = self.record("user", text);
        let restart = {
            let mut state = self.state();
            // The id lets a project keep these exact words (requestIds).
            state.queue.push_back(format!("[user message {}]\n{text}", row["id"].as_str().unwrap_or("")));
            matches!(state.phase, Phase::Stopped | Phase::Off)
        };
        if restart {
            let assistant = Arc::clone(self);
            tokio::spawn(async move { assistant.start().await });
        }
        self.kick.notify_one();
        Ok(self.snapshot().await)
    }

    /// Whether the Assistant said something (a reply or an error) after the
    /// last time the person looked at its pane. One mark for every window.
    fn unseen(&self) -> bool {
        let seen = std::fs::read_to_string(self.dir.join("seen.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value["at"].as_str().map(str::to_string))
            .unwrap_or_default();
        self.latest_said().is_some_and(|at| at > seen)
    }

    /// When the Assistant last said something to the person.
    fn latest_said(&self) -> Option<String> {
        std::fs::read_to_string(self.transcript())
            .unwrap_or_default()
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|row| matches!(row["kind"].as_str(), Some("assistant" | "error")))
            .and_then(|row| row["at"].as_str().map(str::to_string))
    }

    /// The person has seen the pane: everything said so far is read.
    pub async fn mark_seen(&self) -> Result<Value, ApiError> {
        if self.unseen() {
            let at = self.latest_said().unwrap_or_default();
            std::fs::create_dir_all(&self.dir).map_err(io)?;
            std::fs::write(self.dir.join("seen.json"), json!({ "at": at }).to_string()).map_err(io)?;
            self.sessions.publish_control("assistant.changed", json!({ "seen": at }));
        }
        Ok(self.snapshot().await)
    }

    pub fn messages(&self, limit: usize) -> Value {
        let rows: Vec<Value> = std::fs::read_to_string(self.transcript())
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let start = rows.len().saturating_sub(limit.clamp(1, 500));
        json!({ "messages": rows[start..] })
    }

    async fn start(self: &Arc<Self>) {
        {
            let mut state = self.state();
            if matches!(state.phase, Phase::Starting | Phase::Idle | Phase::Running) {
                return;
            }
            state.phase = Phase::Starting;
            state.error = None;
        }
        self.set_phase(Phase::Starting, None);
        if let Err(message) = self.spawn().await {
            crate::log(self.sessions.home(), "warn", "assistant.start_failed", json!({ "message": message }));
            if message == RUNTIME_ENDED {
                // The event loop says why, from what the runtime wrote.
                return;
            }
            self.record("error", &message);
            self.stop_process(Phase::Stopped, Some(message)).await;
        }
    }

    /// Writes what the runtime is started with: the prompt, the skills, the
    /// extension and the tools it lists.
    fn write_files(&self) -> Result<Files, String> {
        let error = |error: std::io::Error| error.to_string();
        std::fs::create_dir_all(&self.dir).map_err(error)?;
        let prompt = self.dir.join("prompt.md");
        std::fs::write(&prompt, self.system_prompt()).map_err(error)?;
        let mut skills = Vec::new();
        for (name, text) in SKILLS {
            let folder = self.dir.join("skills").join(name);
            std::fs::create_dir_all(&folder).map_err(error)?;
            std::fs::write(folder.join("SKILL.md"), text).map_err(error)?;
            skills.push(folder);
        }
        let extension = self.dir.join("extension").join("jouzu-assistant");
        std::fs::create_dir_all(&extension).map_err(error)?;
        for (name, text) in EXTENSION {
            std::fs::write(extension.join(name), text).map_err(error)?;
        }
        let tools = self.dir.join("extension").join("tools.json");
        std::fs::write(&tools, serde_json::to_vec(&tool_definitions()).map_err(|error| error.to_string())?).map_err(error)?;
        Ok(Files { prompt, skills, extension, tools })
    }

    /// The runtime's arguments after the ones every session's runtime gets.
    fn arguments(&self, files: &Files) -> Vec<String> {
        let path = |path: &Path| path.to_string_lossy().into_owned();
        let mut tools: Vec<String> = tool_definitions()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        tools.extend(READ_TOOLS.iter().map(|tool| tool.to_string()));
        let mut arguments = vec![
            "--session-dir".to_string(),
            path(&self.dir.join("sessions")),
            "--session-id".to_string(),
            SESSION_ID.to_string(),
            "--system-prompt".to_string(),
            path(&files.prompt),
            "--tools".to_string(),
            tools.join(","),
            "--no-extensions".to_string(),
            "--extension".to_string(),
            path(&files.extension),
            "--no-skills".to_string(),
        ];
        for skill in &files.skills {
            arguments.push("--skill".to_string());
            arguments.push(path(skill));
        }
        arguments.extend(["--no-context-files", "--no-mcp", "--no-prompt-templates"].map(str::to_string));
        arguments
    }

    async fn spawn(self: &Arc<Self>) -> Result<(), String> {
        let model = self.settings().model.ok_or("Choose a model for the Assistant")?;
        let port = *self.port.get().ok_or("The Assistant's bridge is not ready")?;
        let mut launch = self.sessions.runtime_launch().await.ok_or("The runtime is not installed yet")??;
        let spec = self.paths.runtime.clone().unwrap_or_else(|| launch.spec.clone());
        let mut environment = std::mem::take(&mut launch.environment);
        let files = self.write_files()?;
        let token = crate::new_token();
        let mut set = |name: &str, value: OsString| {
            environment.retain(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(name));
            environment.push((OsString::from(name), value));
        };
        set("JOUZU_FLOW_CONTROL", "0".into());
        set("JOUZU_ASSISTANT_URL", format!("http://127.0.0.1:{port}/v1/assistant/bridge").into());
        set("JOUZU_ASSISTANT_TOKEN", token.clone().into());
        set("JOUZU_ASSISTANT_TOOLS", files.tools.clone().into_os_string());
        // jouzu reads its own options before Pi's, right after the script.
        let mut args = spec.args.clone();
        let at = args.len().min(1);
        for (offset, option) in JOUZU_OPTIONS.iter().enumerate() {
            args.insert(at + offset, option.to_string());
        }
        args.extend(self.arguments(&files));
        let (events_tx, events_rx) = mpsc::channel(256);
        let supervisor = RuntimeSupervisor::start(
            SpawnSpec { program: spec.program.clone(), args, env: environment, workspace: self.dir.clone(), low_priority: false },
            events_tx,
        )
        .map_err(|error| format!("Could not start the Assistant: {error}"))?;
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        *self.runtime_guard() = Some(Runtime { supervisor: supervisor.clone(), token });
        let assistant = Arc::clone(self);
        tokio::spawn(async move { assistant.event_loop(events_rx, generation).await });
        crate::log(self.sessions.home(), "info", "assistant.runtime_started", json!({ "pid": supervisor.pid() }));

        // Ready once it answers; then on the model the user chose, never another.
        self.command(&supervisor, command::get_state()).await?;
        launch.answered();
        self.command(&supervisor, command::set_model(&model.provider, &model.id))
            .await
            .map_err(|error| format!("{} · {}: {error}", model.provider, model.id))?;
        if let Some(level) = model.thinking.as_deref() {
            self.command(&supervisor, command::set_thinking_level(level)).await?;
        }
        if self.generation.load(std::sync::atomic::Ordering::SeqCst) == generation {
            supervisor.set_probe_enabled(true);
            self.set_phase(Phase::Idle, None);
        }
        Ok(())
    }

    /// One command and the runtime's answer; a refusal is its own words.
    /// A command, answered by the runtime or ended by it exiting: the host sets
    /// no deadline of its own (D1).
    async fn command(&self, supervisor: &RuntimeSupervisor, value: Value) -> Result<Value, String> {
        let id = format!("assistant-{}", crate::new_token().get(..12).unwrap_or("0"));
        let kind = command::kind(&value).unwrap_or("command").to_string();
        match supervisor.answer(command::with_id(value, &id)).await {
            Ok(value) => Ok(value),
            Err(crate::runtime::RequestError::Runtime(message)) => Err(message),
            Err(crate::runtime::RequestError::Timeout) => Err(format!("The runtime did not answer {kind}")),
            Err(crate::runtime::RequestError::Closed(_)) => Err(RUNTIME_ENDED.to_string()),
        }
    }

    fn runtime_guard(&self) -> std::sync::MutexGuard<'_, Option<Runtime>> {
        self.runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn supervisor(&self) -> Option<Arc<RuntimeSupervisor>> {
        self.runtime_guard().as_ref().map(|runtime| runtime.supervisor.clone())
    }

    fn system_prompt(&self) -> String {
        PROMPT.to_string()
    }

    /// What the runtime reports, until it ends.
    async fn event_loop(self: Arc<Self>, mut events: mpsc::Receiver<RuntimeEvent>, generation: u64) {
        let current = |assistant: &Assistant| assistant.generation.load(std::sync::atomic::Ordering::SeqCst) == generation;
        let mut last_stderr = String::new();
        let mut code = None;
        while let Some(event) = events.recv().await {
            if !current(&self) {
                continue;
            }
            match event {
                RuntimeEvent::Line(value) => self.handle_line(&value),
                RuntimeEvent::Stderr(line) => {
                    crate::log(self.sessions.home(), "debug", "assistant.stderr", json!({ "line": cut(&line, 2000) }));
                    if telling(&line, &last_stderr) {
                        last_stderr = cut(line.trim(), 500);
                    }
                }
                RuntimeEvent::ParseError(_) | RuntimeEvent::IoError(_) => {}
                RuntimeEvent::Exited(exit) => {
                    code = exit;
                    break;
                }
            }
        }
        if !current(&self) || self.state().phase == Phase::Off {
            return;
        }
        let mut message = match code {
            Some(code) => format!("{RUNTIME_ENDED} (exit code {code})"),
            None => RUNTIME_ENDED.to_string(),
        };
        if !last_stderr.is_empty() {
            message.push_str(&format!(": {last_stderr}"));
        }
        self.record("error", &message);
        self.stop_process(Phase::Stopped, Some(message)).await;
    }

    fn handle_line(&self, value: &Value) {
        match pi::classify(value) {
            Record::MessageEnd if value["message"]["role"] == "assistant" => {
                let message = &value["message"];
                if message["stopReason"] == "error" {
                    let error = message["errorMessage"].as_str().unwrap_or("The model call failed");
                    self.record("error", error);
                    return;
                }
                let text = pi::content_text(&message["content"]);
                if !text.trim().is_empty() {
                    self.record("assistant", text.trim());
                }
            }
            Record::AgentSettled => {
                if self.state().phase == Phase::Running {
                    self.set_phase(Phase::Idle, None);
                }
            }
            Record::ExtensionUiRequest => {
                // Nobody sits at the Assistant's runtime to answer a dialog: a
                // question is declined at once rather than left waiting.
                let method = value["method"].as_str().unwrap_or("");
                if matches!(method, "select" | "confirm" | "input" | "editor") {
                    if let (Some(id), Some(supervisor)) = (value["id"].as_str(), self.supervisor()) {
                        let _ = supervisor.enqueue(command::ui_cancelled(id));
                    }
                }
                if method == "notify" {
                    crate::log(self.sessions.home(), "info", "assistant.notice", json!({ "message": value["message"] }));
                }
            }
            Record::ExtensionError | Record::Error => {
                crate::log(self.sessions.home(), "warn", "assistant.runtime_error", json!({ "event": value }));
            }
            _ => {}
        }
    }

    async fn stop_process(&self, phase: Phase, error: Option<String>) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(runtime) = self.runtime_guard().take() {
            runtime.supervisor.terminate();
        }
        self.set_phase(phase, error);
    }

    /// A call from the Assistant's runtime, through its extension. Only the
    /// token made for the runtime now running opens it.
    pub async fn bridge(&self, token: &str, name: &str, arguments: &Value) -> Result<Value, ApiError> {
        let allowed = self.runtime_guard().as_ref().is_some_and(|runtime| same(&runtime.token, token));
        if !allowed {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "Not the Assistant's runtime", false));
        }
        Ok(match self.run_tool(name, arguments).await {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(error) => json!({ "ok": false, "error": { "code": error.code, "message": error.message } }),
        })
    }

    /// Delivers what is due whenever the Assistant is idle. Runs when
    /// something happens: a user message, the Assistant going idle, a task
    /// change, or a scheduled wake coming due.
    async fn schedule_loop(self: Arc<Self>) {
        loop {
            let inbox = self.tasks.inbox_changed();
            tokio::pin!(inbox);
            inbox.as_mut().enable();
            let due = self.state().scheduled.iter().map(|wake| wake.at).min();
            let next = self.next_turn();
            if next.is_none() {
                let kicked = self.kick.notified();
                match due {
                    Some(at) => tokio::select! {
                        _ = kicked => {}
                        _ = inbox => {}
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(at)) => {}
                    },
                    None => tokio::select! {
                        _ = kicked => {}
                        _ = inbox => {}
                    },
                }
                continue;
            }
            if let Some(text) = next {
                let turn = {
                    let mut state = self.state();
                    state.turn += 1;
                    state.phase = Phase::Running;
                    state.turn
                };
                crate::log(self.sessions.home(), "info", "assistant.turn", json!({ "turn": turn }));
                let assistant = Arc::clone(&self);
                tokio::spawn(async move { assistant.deliver(text).await });
            }
        }
    }

    /// Hands one turn to the runtime. The run's end (agent_settled) makes the
    /// Assistant idle again; a prompt the runtime refuses or handles without a
    /// run does at once.
    async fn deliver(self: Arc<Self>, text: String) {
        let Some(supervisor) = self.supervisor() else {
            self.set_phase(Phase::Stopped, Some("The Assistant stopped".into()));
            return;
        };
        match self.command(&supervisor, command::prompt(&text, &[])).await {
            Ok(value) if value.pointer("/data/disposition").and_then(Value::as_str) == Some("handled") => {
                if self.state().phase == Phase::Running {
                    self.set_phase(Phase::Idle, None);
                }
            }
            Ok(_) => {}
            Err(message) => {
                self.record("error", &message);
                if self.state().phase == Phase::Running {
                    self.set_phase(Phase::Idle, Some(message));
                }
            }
        }
    }

    /// The next turn to take, if any: the user first, then a wake.
    fn next_turn(&self) -> Option<String> {
        // Off, starting or busy: nothing to read, nothing to log.
        if self.state().phase != Phase::Idle {
            return None;
        }
        // The host's own look at the inbox, not the Assistant's: no policy check.
        let inbox = Some(self.tasks.peek_inbox(CLIENT));
        let memory = self.memory_index_text();
        let mut state = self.state();
        if state.phase != Phase::Idle {
            return None;
        }
        let memory_note = (memory != state.memory_seen).then(|| {
            state.memory_seen = memory.clone();
            format!("\n\n[Memory index]\n{memory}")
        });
        if let Some(text) = state.queue.pop_front() {
            return Some(format!("{text}{}", memory_note.unwrap_or_default()));
        }
        let now = Instant::now();
        let entries: Vec<Value> = inbox
            .as_ref()
            .and_then(|inbox| inbox["entries"].as_array().cloned())
            .unwrap_or_default();
        let newest = entries.iter().filter_map(|entry| entry["seq"].as_u64()).max().unwrap_or(0);
        let inbox_wake = newest > state.woken_seq;
        let due: Vec<String> = state
            .scheduled
            .iter()
            .filter(|wake| wake.at <= now)
            .map(|wake| wake.note.clone())
            .collect();
        if !inbox_wake && due.is_empty() {
            return None;
        }
        state.scheduled.retain(|wake| wake.at > now);
        save_wakes(&self.dir, &state.scheduled);
        let mut text = String::from("[wake]");
        if inbox_wake {
            state.woken_seq = newest;
            text.push_str(&wake_summary(&entries));
        }
        for note in due {
            text.push_str(&format!("\nScheduled wake: {note}"));
        }
        drop(state);
        self.record("wake", &text);
        Some(format!("{text}{}", memory_note.unwrap_or_default()))
    }

    async fn run_tool(&self, name: &str, arguments: &Value) -> Result<Value, ApiError> {
        let client = AgentClient::builtin(CLIENT);
        match name {
            "list_projects" => {
                let mut snapshot = self.projects.snapshot()?;
                // The Assistant sees which sessions exist, not their contents.
                snapshot.as_object_mut().map(|object| object.remove("workspaces"));
                // Each project with the person's words it was asked with, unchanged.
                if let Some(projects) = snapshot["projects"].as_array_mut() {
                    for project in projects {
                        let ids: Vec<String> = serde_json::from_value(project["requestIds"].clone()).unwrap_or_default();
                        project["requests"] = json!(self.user_messages(&ids).unwrap_or_default());
                    }
                }
                Ok(snapshot)
            }
            "save_project" => {
                let id = arguments["id"].as_str().filter(|id| !id.is_empty()).map(str::to_string);
                let mut fields = arguments.clone();
                if let Some(object) = fields.as_object_mut() {
                    object.remove("id");
                }
                let project: Project = serde_json::from_value(fields)
                    .map_err(|error| ApiError::bad_request(format!("Invalid project: {error}")))?;
                // The person's own words the work is checked against.
                self.user_messages(&project.request_ids)?;
                self.projects.save_project(CLIENT, project, id.as_deref())
            }
            "memory_index" => Ok(json!({ "index": self.memory_index_text() })),
            "memory_read" => self.memory_read(string(arguments, "name")?),
            "memory_write" => self.memory_write(arguments),
            "memory_delete" => self.memory_delete(string(arguments, "name")?),
            "memory_search" => self.memory_search(string(arguments, "query")?),
            "history_search" => Ok(self.history_search(string(arguments, "query")?, arguments["limit"].as_u64().map(|limit| limit as usize))),
            "schedule_wake" => {
                let seconds = arguments["seconds"].as_u64().ok_or_else(|| ApiError::bad_request("seconds is required"))?;
                let note = arguments["note"].as_str().unwrap_or("").to_string();
                let mut state = self.state();
                state.scheduled.push(Wake { at: Instant::now() + Duration::from_secs(seconds), note });
                save_wakes(&self.dir, &state.scheduled);
                let scheduled = state.scheduled.len();
                drop(state);
                // The loop sleeps until the earliest wake: it must hear of this one.
                self.kick.notify_one();
                Ok(json!({ "scheduled": scheduled }))
            }
            "get_workflow" => self.workflow().read(),
            "save_workflow" => {
                let revision = string(arguments, "revision")?;
                self.workflow().save(&arguments["config"], revision, CLIENT)
            }
            "list_workflow_versions" => Ok(self.workflow().versions()),
            "restore_workflow" => self.workflow().restore(string(arguments, "version")?, CLIENT),
            "list_sessions" => Ok(self.list_sessions(arguments["limit"].as_u64().map(|limit| limit as usize))),
            "read_session" => {
                let limit = arguments["limit"].as_u64().ok_or_else(|| ApiError::bad_request("limit is required"))?;
                self.tasks.read_session(string(arguments, "sessionPath")?, limit as usize)
            }
            _ => mcp::call_task_tool(&self.tasks, &self.sessions, &client, name, arguments).await,
        }
    }

    /// The person's messages with these ids, word for word: `{id, at, text}`.
    /// Only the person's own messages; anything else is refused.
    fn user_messages(&self, ids: &[String]) -> Result<Vec<Value>, ApiError> {
        if ids.len() > 50 {
            return Err(ApiError::bad_request("requestIds names at most 50 user message ids"));
        }
        let rows: Vec<Value> = std::fs::read_to_string(self.transcript())
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        ids.iter()
            .map(|id| {
                rows.iter()
                    .find(|row| row["id"] == id.as_str() && row["kind"] == "user")
                    .map(|row| json!({ "id": id, "at": row["at"], "text": row["text"] }))
                    .ok_or_else(|| ApiError::bad_request(format!("{id} is not a message from the user")))
            })
            .collect()
    }

    /// Recent sessions in every folder, newest first, with which are tasks.
    /// Recent sessions, newest first: the newest `limit`, or all.
    fn list_sessions(&self, limit: Option<usize>) -> Value {
        let mut sessions = self.sessions.persisted(None, false);
        let live = self.sessions.list();
        let key = |value: &Value| value["sessionPath"].as_str().map(|path| path.replace('\\', "/").to_lowercase());
        for session in live {
            match sessions.iter_mut().find(|saved| key(saved).is_some() && key(saved) == key(&session)) {
                Some(saved) => *saved = session,
                None if key(&session).is_some() => sessions.push(session),
                None => {}
            }
        }
        self.tasks.mark_sessions(&mut sessions);
        sessions.sort_by(|a, b| b["updatedAt"].as_str().unwrap_or("").cmp(a["updatedAt"].as_str().unwrap_or("")));
        if let Some(limit) = limit {
            sessions.truncate(limit);
        }
        let rows: Vec<Value> = sessions
            .iter()
            .map(|session| json!({
                "sessionPath": session["sessionPath"],
                "title": session["title"],
                "workspace": session["workspacePath"],
                "updatedAt": session["updatedAt"],
                "status": session["status"],
                "task": session["task"],
            }))
            .collect();
        json!({ "sessions": rows })
    }

    fn workflow(&self) -> crate::workflow::Workflow {
        crate::workflow::Workflow::new(self.sessions.runtime_home(), self.sessions.home())
    }

    fn memory_index_text(&self) -> String {
        let Ok(entries) = std::fs::read_dir(self.memory_dir()) else { return String::new() };
        let mut lines: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().strip_suffix(".md")?.to_string();
                let text = std::fs::read_to_string(entry.path()).ok()?;
                let field = |key: &str| {
                    text.lines()
                        .find_map(|line| line.strip_prefix(&format!("{key}:")))
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string()
                };
                Some(format!("- {name} ({}): {}", field("type"), field("description")))
            })
            .collect();
        lines.sort();
        lines.join("\n")
    }

    fn memory_path(&self, name: &str) -> Result<PathBuf, ApiError> {
        let valid = !name.is_empty()
            && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !valid {
            return Err(ApiError::bad_request("A memory name is a-z, 0-9 and -"));
        }
        Ok(self.memory_dir().join(format!("{name}.md")))
    }

    fn memory_read(&self, name: &str) -> Result<Value, ApiError> {
        let text = std::fs::read_to_string(self.memory_path(name)?)
            .map_err(|_| ApiError::bad_request(format!("No memory named {name}")))?;
        Ok(json!({ "name": name, "text": text }))
    }

    fn memory_write(&self, arguments: &Value) -> Result<Value, ApiError> {
        let name = string(arguments, "name")?;
        let kind = string(arguments, "type")?;
        if !MEMORY_TYPES.contains(&kind) {
            return Err(ApiError::bad_request(format!("type is one of {}", MEMORY_TYPES.join(", "))));
        }
        let description = string(arguments, "description")?.replace('\n', " ");
        let body = string(arguments, "body")?;
        let text = format!("---\nname: {name}\ndescription: {description}\ntype: {kind}\nupdated: {}\n---\n{body}\n", now_iso());
        let path = self.memory_path(name)?;
        std::fs::create_dir_all(self.memory_dir()).map_err(io)?;
        let existed = path.is_file();
        std::fs::write(path, text).map_err(io)?;
        Ok(json!({ "name": name, "created": !existed }))
    }

    fn memory_delete(&self, name: &str) -> Result<Value, ApiError> {
        std::fs::remove_file(self.memory_path(name)?).map_err(|_| ApiError::bad_request(format!("No memory named {name}")))?;
        Ok(json!({ "deleted": name }))
    }

    fn memory_search(&self, query: &str) -> Result<Value, ApiError> {
        let query = query.to_lowercase();
        let mut hits = Vec::new();
        for entry in std::fs::read_dir(self.memory_dir()).into_iter().flatten().filter_map(Result::ok) {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let lines: Vec<&str> = text.lines().filter(|line| line.to_lowercase().contains(&query)).collect();
            if !lines.is_empty() {
                let name = entry.file_name().to_string_lossy().trim_end_matches(".md").to_string();
                hits.push(json!({ "name": name, "lines": lines }));
            }
        }
        Ok(json!({ "hits": hits }))
    }

    /// Transcript rows containing `query`: the newest `limit`, or all.
    fn history_search(&self, query: &str, limit: Option<usize>) -> Value {
        let query = query.to_lowercase();
        let rows: Vec<Value> = std::fs::read_to_string(self.transcript())
            .unwrap_or_default()
            .lines()
            .filter(|line| line.to_lowercase().contains(&query))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect();
        let start = limit.map_or(0, |limit| rows.len().saturating_sub(limit));
        json!({ "hits": rows[start..] })
    }
}

/// Whether a line of the runtime's error output says more about why it ended
/// than `kept`: Node's own trailer and stack frames never do, and an error
/// line is kept over the lines that follow it.
fn telling(line: &str, kept: &str) -> bool {
    let line = line.trim();
    let noise = line.is_empty()
        || line.starts_with("at ")
        || line.starts_with("Node.js v")
        || line.len() < 3
        || line.starts_with("code:")
        || line.starts_with("requireStack");
    !noise && (line.contains("Error") || !kept.contains("Error"))
}

/// The files the Assistant's runtime is started with.
struct Files {
    prompt: PathBuf,
    skills: Vec<PathBuf>,
    extension: PathBuf,
    tools: PathBuf,
}

/// Compares tokens without stopping at the first difference.
fn same(expected: &str, presented: &str) -> bool {
    expected.len() == presented.len()
        && !expected.is_empty()
        && expected.bytes().zip(presented.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[derive(Deserialize)]
struct BridgeCall {
    name: String,
    #[serde(default)]
    arguments: Value,
}

/// The route the Assistant's runtime calls its tools on (`/v1/assistant/bridge`).
/// It takes the runtime's own token only, never the host's or an agent's.
pub fn bridge_router<S: Clone + Send + Sync + 'static>(assistant: Arc<Assistant>) -> Router<S> {
    Router::new().route("/", post(bridge_call)).with_state(assistant)
}

async fn bridge_call(Extract(assistant): Extract<Arc<Assistant>>, headers: HeaderMap, Json(call): Json<BridgeCall>) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    match assistant.bridge(token, &call.name, &call.arguments).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

fn string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    arguments[name]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
}

/// What changed, in one line: how many tasks, by state. The entries
/// themselves are read with read_inbox.
fn wake_summary(entries: &[Value]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for entry in entries {
        let state = entry["state"].as_str().unwrap_or("?").to_string();
        match counts.iter_mut().find(|(name, _)| *name == state) {
            Some((_, count)) => *count += 1,
            None => counts.push((state, 1)),
        }
    }
    let counts: Vec<String> = counts.iter().map(|(state, count)| format!("{state} {count}")).collect();
    let mut text = format!(" Inbox: {} task(s) changed ({}).", entries.len(), counts.join(", "));
    let wrote = entries.iter().filter(|entry| entry["userWrote"] == true).count();
    if wrote > 0 {
        text.push_str(&format!(" The user wrote in {wrote} of them."));
    }
    text.push_str("\nread_inbox for the entries, handle them, then ack_inbox with the highest seq you handled.");
    text
}

/// Every tool the Assistant has: the task tools agents get over MCP, plus
/// projects, memory, history and wakes. Skills are jouzu's own (`--skill`).
pub fn tool_definitions() -> Vec<Value> {
    let mut tools = mcp::task_tools();
    let name = json!({ "type": "string", "description": "kebab-case, a-z 0-9 -" });
    tools.extend([
        json!({ "name": "list_projects", "description": "The user's projects (name, description, linked folders, sessions, tasks, and requests: the user's own messages the project was asked with, word for word) and the sessions that exist.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "save_project", "description": "Create a project (no id) or replace one (with its id). Omitted lists become empty. Links must name existing workspaces (ids from list_workspaces are paths; use list_projects for workspace ids), sessions and your tasks.", "inputSchema": { "type": "object", "properties": {
            "id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" },
            "workspaceIds": { "type": "array", "items": { "type": "string" } },
            "sessionIds": { "type": "array", "items": { "type": "string" } },
            "taskIds": { "type": "array", "items": { "type": "string" } },
            "requestIds": { "type": "array", "items": { "type": "string" }, "description": "Ids of the user's messages (the m… in [user message m…]) that ask for this project's work. Kept so you check results against the user's own words, not your retelling." } }, "required": ["name"] } }),
        json!({ "name": "list_sessions", "description": "Recent sessions in all the user's folders, newest first: path, title, folder, time, status, and task (who started it) when it is a task. Read only.", "inputSchema": { "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "description": "The newest this many; all when left out." } } } }),
        json!({ "name": "read_session", "description": "Read any session's latest messages, each whole. Read only: you can write only to your own tasks.", "inputSchema": { "type": "object", "properties": { "sessionPath": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "description": "How many of the latest messages." } }, "required": ["sessionPath", "limit"] } }),
        json!({ "name": "memory_index", "description": "One line per memory: name (type): description.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "memory_read", "description": "Read one memory.", "inputSchema": { "type": "object", "properties": { "name": name }, "required": ["name"] } }),
        json!({ "name": "memory_write", "description": "Create or replace one memory (one subject per memory, at most 4 KB). type: user, feedback, project, decision or reference. The body says the fact, why it matters and what it does not mean. Never store live task state.", "inputSchema": { "type": "object", "properties": {
            "name": name, "type": { "type": "string", "enum": MEMORY_TYPES }, "description": { "type": "string", "description": "One line, used to decide relevance" }, "body": { "type": "string" } }, "required": ["name", "type", "description", "body"] } }),
        json!({ "name": "memory_delete", "description": "Delete a memory that is wrong or no longer true.", "inputSchema": { "type": "object", "properties": { "name": name }, "required": ["name"] } }),
        json!({ "name": "memory_search", "description": "Find memories containing a text.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } }),
        json!({ "name": "history_search", "description": "Find earlier messages, replies and wakes of your conversation containing a text.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "description": "The newest this many; all when left out." } }, "required": ["query"] } }),
        json!({ "name": "schedule_wake", "description": "Be woken after some seconds with a note to yourself.", "inputSchema": { "type": "object", "properties": { "seconds": { "type": "integer", "minimum": 1 }, "note": { "type": "string" } }, "required": ["seconds"] } }),
        json!({ "name": "get_workflow", "description": "jouzu's workflow definitions (agents.json): roles, their model tier, tools, instructions, maxConcurrent. config is null while the runtime uses its defaults. Load the configure-workflow skill first.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "save_workflow", "description": "Replace the workflow definitions. Pass the revision get_workflow returned; a change since then is refused. The replaced version is kept and can be restored.", "inputSchema": { "type": "object", "properties": { "config": { "type": "object" }, "revision": { "type": "string" } }, "required": ["config", "revision"] } }),
        json!({ "name": "list_workflow_versions", "description": "Earlier workflow definitions kept on each save, oldest first.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "restore_workflow", "description": "Put an earlier workflow version back (the current one is kept).", "inputSchema": { "type": "object", "properties": { "version": { "type": "string" } }, "required": ["version"] } }),
    ]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn faux_pick() -> ModelPick {
        ModelPick { provider: "faux".into(), id: "faux-1".into(), thinking: None }
    }

    #[tokio::test]
    async fn the_assistant_never_turns_on_without_a_chosen_model() {
        let fixture = setup();
        let refused = fixture.assistant.update(Some(true), None).await.unwrap_err();
        assert!(refused.message.contains("Choose a model"), "{}", refused.message);
        assert_eq!(fixture.assistant.snapshot().await["enabled"], false);
        let bad = ModelPick { thinking: Some("extreme".into()), ..faux_pick() };
        assert!(fixture.assistant.update(Some(true), Some(Some(bad))).await.is_err());
        assert_eq!(fixture.assistant.snapshot().await["enabled"], false);
    }

    struct Fixture {
        assistant: Arc<Assistant>,
        tasks: Arc<TaskManager>,
        workspace: tempfile::TempDir,
        log: PathBuf,
        _home: tempfile::TempDir,
    }

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
    }

    /// The Assistant on a stand-in runtime (fake-assistant.mjs) that loads the
    /// real jouzu-assistant extension, with the bridge served as the host serves it.
    fn setup() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionManager::new(
            Some(RuntimeSpec::node_script(&fixtures().join("fake-runtime.mjs"))),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            None,
        ));
        sessions.add_workspaces(&[workspace.path().to_string_lossy().into_owned()]).unwrap();
        // The models tasks may name are the warm runtime's.
        sessions.enable_warm_runtime();
        let tasks = TaskManager::new(sessions.clone());
        let projects = ProjectStore::new(sessions.clone(), tasks.clone());
        // The stand-in writes it in its working folder, the Assistant's folder.
        let log = home.path().join("assistant").join("turns.log");
        let paths = AssistantPaths { runtime: Some(RuntimeSpec::node_script(&fixtures().join("fake-assistant.mjs"))) };
        let assistant = Assistant::new(home.path(), paths, sessions, tasks.clone(), projects);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        assistant.set_port(listener.local_addr().unwrap().port());
        let router = Router::new().nest("/v1/assistant/bridge", bridge_router(assistant.clone()));
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = axum::serve(listener, router).await;
        });
        Fixture { assistant, tasks, workspace, log, _home: home }
    }

    async fn until_async<F: std::future::Future<Output = bool>>(mut check: impl FnMut() -> F) {
        for _ in 0..200 {
            if check().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition was not reached");
    }

    fn errors(assistant: &Assistant) -> Vec<String> {
        assistant.messages(500)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "error")
            .filter_map(|row| row["text"].as_str().map(str::to_string))
            .collect()
    }

    async fn until(mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition was not reached");
    }

    fn replies(assistant: &Assistant) -> Vec<String> {
        assistant.messages(500)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "assistant")
            .filter_map(|row| row["text"].as_str().map(str::to_string))
            .collect()
    }

    fn turns(log: &Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    #[tokio::test]
    async fn a_user_message_gets_a_reply_and_tools_run_on_the_host() {
        let fixture = setup();
        fixture.assistant.launch();
        let refused = fixture.assistant.send("hello").await.unwrap_err();
        assert_eq!(refused.code, "assistant-off");
        fixture.assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        fixture.assistant.send("hello").await.unwrap();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply == "ok: hello")).await;
        fixture.assistant.send("tool list_workspaces").await.unwrap();
        let folder = fixture.workspace.path().file_name().unwrap().to_string_lossy().into_owned();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply.contains(&folder))).await;
        // Refused tool calls come back as results the Assistant reads.
        fixture.assistant.send("tool start_task {\"workspace\":\"/\",\"text\":\"/flow clear\"}").await.unwrap();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply.contains("\"ok\":false"))).await;
    }

    #[tokio::test]
    async fn what_the_assistant_said_is_unseen_until_its_pane_is_seen() {
        let fixture = setup();
        let assistant = &fixture.assistant;
        assert_eq!(assistant.snapshot().await["unseen"], false);
        assistant.record("user", "hello");
        assert_eq!(assistant.snapshot().await["unseen"], false, "the person's own words are not news");
        assistant.record("assistant", "hi");
        assert_eq!(assistant.snapshot().await["unseen"], true);
        assert_eq!(assistant.mark_seen().await.unwrap()["unseen"], false);
        tokio::time::sleep(Duration::from_millis(5)).await;
        assistant.record("error", "the model refused");
        assert_eq!(assistant.snapshot().await["unseen"], true);
    }

    #[tokio::test]
    async fn a_project_keeps_the_users_own_words_and_the_assistant_reads_any_session() {
        let fixture = setup();
        let assistant = &fixture.assistant;
        let said = assistant.record("user", "Please fix the login bug.\nIt fails on Safari only.");
        let id = said["id"].as_str().unwrap().to_string();
        let reply = assistant.record("assistant", "On it.");
        let folder = fixture.workspace.path().to_string_lossy().into_owned();
        until_async(|| async { matches!(assistant.sessions.runtime_models().await, Some(Ok(_))) }).await;

        // Only the person's messages are kept as what they asked.
        let refused = assistant
            .run_tool("save_project", &json!({ "name": "Login", "requestIds": [reply["id"]] }))
            .await
            .unwrap_err();
        assert!(refused.message.contains("not a message from the user"), "{}", refused.message);
        assistant.run_tool("save_project", &json!({ "name": "Login", "requestIds": [id] })).await.unwrap();
        let listed = assistant.run_tool("list_projects", &json!({})).await.unwrap();
        assert_eq!(listed["projects"][0]["requests"][0]["text"], "Please fix the login bug.\nIt fails on Safari only.", "word for word: {listed}");

        // A task gets the brief alone: nothing is added to it.
        let task = assistant
            .run_tool("start_task", &json!({ "workspace": folder, "text": "Find why login fails on Safari only.", "model": { "provider": "fixture", "id": "model" } }))
            .await
            .unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        let mut first = String::new();
        until(|| {
            let read = fixture.tasks.read(CLIENT, &task_id, 20).unwrap();
            first = read["messages"].as_array().and_then(|rows| rows.iter().find(|row| row["role"] == "user")).and_then(|row| row["text"].as_str()).unwrap_or("").to_string();
            !first.is_empty()
        })
        .await;
        assert_eq!(first, "Find why login fails on Safari only.");

        // It sees every session, with which are tasks, and reads one whole.
        let mut path = None;
        until(|| {
            let listed = assistant.list_sessions(Some(10));
            path = listed["sessions"].as_array().unwrap().iter().find(|row| row["task"]["taskId"] == task_id.as_str()).and_then(|row| row["sessionPath"].as_str().map(str::to_string));
            path.is_some()
        })
        .await;
        let read = assistant.run_tool("read_session", &json!({ "sessionPath": path.unwrap(), "limit": 30 })).await.unwrap();
        assert!(read["messages"].as_array().unwrap().iter().any(|row| row["text"].as_str().is_some_and(|text| text.contains("Safari only"))), "{read}");
        let outside = assistant.run_tool("read_session", &json!({ "sessionPath": "/etc/passwd", "limit": 30 })).await.unwrap_err();
        assert!(outside.message.contains("No such session"));
    }

    #[tokio::test]
    async fn a_scheduled_wake_survives_a_restart() {
        let fixture = setup();
        fixture.assistant.run_tool("schedule_wake", &json!({ "seconds": 3600, "note": "check the release" })).await.unwrap();
        let again = Assistant::new(
            fixture._home.path(),
            Assistant::default_paths(fixture._home.path(), &fixture.assistant.sessions),
            fixture.assistant.sessions.clone(),
            fixture.tasks.clone(),
            fixture.assistant.projects.clone(),
        );
        let wakes = again.snapshot().await["scheduledWakes"].clone();
        assert_eq!(wakes.as_array().map(Vec::len), Some(1), "{wakes}");
        assert_eq!(wakes[0]["note"], "check the release");
        assert!(wakes[0]["inSeconds"].as_u64().is_some_and(|left| (3590..=3600).contains(&left)), "{wakes}");
    }

    #[tokio::test]
    async fn task_changes_wake_the_assistant_when_idle_and_none_is_lost() {
        let fixture = setup();
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Idle).await;
        let folder = fixture.workspace.path().to_string_lossy().into_owned();
        for n in 0..5 {
            fixture.tasks.start(CLIENT, &folder, &format!("job {n}")).unwrap();
        }
        let handled = || -> usize {
            replies(&fixture.assistant)
                .iter()
                .filter_map(|reply| reply.strip_prefix("handled ").and_then(|n| n.parse::<usize>().ok()))
                .sum()
        };
        // Each wake hands over what arrived since the last; it acknowledges
        // every entry it handled, so all five end up handled and none is left.
        until(|| handled() >= 5 && fixture.tasks.inbox(CLIENT, 0).unwrap()["entries"].as_array().unwrap().is_empty()).await;
        let wakes: Vec<String> = turns(&fixture.log).into_iter().filter(|text| text.starts_with("[wake]")).collect();
        // Changes that arrive while it works are one wake: never one per change.
        assert!(!wakes.is_empty() && wakes.len() <= 5, "{wakes:?}");
        assert!(wakes.iter().all(|wake| wake.contains("Inbox:")), "no wake without news: {wakes:?}");
    }

    #[tokio::test]
    async fn a_stopped_assistant_stays_stopped_until_the_user_writes() {
        let fixture = setup();
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        fixture.assistant.send("exit").await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Stopped).await;
        assert!(errors(&fixture.assistant).iter().any(|error| error.contains("asked to exit")), "the reason is shown");
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(fixture.assistant.state().phase, Phase::Stopped);
        fixture.assistant.send("again").await.unwrap();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply == "ok: again")).await;
    }

    #[tokio::test]
    async fn an_assistant_that_is_off_reads_and_logs_nothing() {
        let fixture = setup();
        fixture.assistant.launch();
        tokio::time::sleep(Duration::from_millis(1600)).await;
        let log = std::fs::read_to_string(fixture._home.path().join("logs").join("host.log")).unwrap_or_default();
        assert!(!log.contains("policy.authorize"), "{log}");
    }

    #[tokio::test]
    async fn memory_is_one_file_per_subject() {
        let fixture = setup();
        let assistant = &fixture.assistant;
        let write = |name: &str, body: &str| {
            assistant.memory_write(&json!({ "name": name, "type": "decision", "description": "why we do it", "body": body }))
        };
        write("release-gates", "Only regressions block a candidate.").unwrap();
        assert!(write("../escape", "x").is_err());
        assert!(write("Upper", "x").is_err());
        assert!(write("long", &"x".repeat(64 * 1024)).is_ok(), "no size of its own: the model's context is the bound");
        assistant.memory_delete("long").unwrap();
        assert!(assistant.memory_write(&json!({ "name": "x", "type": "secret", "description": "d", "body": "b" })).is_err());
        assert_eq!(assistant.memory_index_text(), "- release-gates (decision): why we do it");
        assert!(assistant.memory_read("release-gates").unwrap()["text"].as_str().unwrap().contains("regressions"));
        assert_eq!(assistant.memory_search("REGRESSIONS").unwrap()["hits"][0]["name"], "release-gates");
        assistant.memory_delete("release-gates").unwrap();
        assert_eq!(assistant.memory_index_text(), "");
    }

    #[tokio::test]
    async fn it_is_a_jouzu_session_with_its_own_configuration() {
        let fixture = setup();
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Idle).await;
        let dir = fixture._home.path().join("assistant");
        let started: Value = serde_json::from_slice(&std::fs::read(dir.join("args.json")).unwrap()).unwrap();
        let argv: Vec<String> = serde_json::from_value(started["argv"].clone()).unwrap();
        let after = |flag: &str| argv.iter().position(|arg| arg == flag).map(|index| argv[index + 1].clone());
        // The sessions' environment, Flow off, and a token for this runtime.
        assert_eq!(started["home"], fixture._home.path().join("data").to_string_lossy().as_ref());
        assert_eq!(started["flow"], "0");
        assert_eq!(started["token"], true);
        // Its own prompt, session, skills; nothing the coder discovers.
        // jouzu's own options come first, before Pi's.
        assert_eq!(argv[0], "--jouzu-textguard-off", "{argv:?}");
        for flag in ["--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--no-prompt-templates"] {
            assert!(argv.iter().any(|arg| arg == flag), "{flag}: {argv:?}");
        }
        assert_eq!(after("--session-id").as_deref(), Some(SESSION_ID));
        assert_eq!(std::fs::read_to_string(after("--system-prompt").unwrap()).unwrap(), PROMPT);
        assert_eq!(argv.iter().filter(|arg| *arg == "--skill").count(), SKILLS.len());
        for (name, text) in SKILLS {
            // Line by line: a Windows checkout may have CRLF endings.
            let mut lines = text.lines();
            assert_eq!(lines.next(), Some("---"), "{name} starts with a header");
            assert_eq!(lines.next(), Some(format!("name: {name}").as_str()), "{name} has a matching header");
            assert_eq!(std::fs::read_to_string(dir.join("skills").join(name).join("SKILL.md")).unwrap(), *text);
        }
        // Only its tools and reading: nothing that writes files or runs commands.
        let tools: Vec<String> = after("--tools").unwrap().split(',').map(str::to_string).collect();
        let mut expected: Vec<String> = tool_definitions().iter().filter_map(|tool| tool["name"].as_str().map(str::to_string)).collect();
        expected.extend(READ_TOOLS.iter().map(|tool| tool.to_string()));
        assert_eq!(tools, expected);
        for coder in ["bash", "write", "edit", "powershell", "agent", "subagent", "background", "skill_read"] {
            assert!(!tools.iter().any(|tool| tool == coder), "{coder}");
        }
    }

    #[tokio::test]
    async fn a_model_the_runtime_refuses_stops_it_with_the_runtimes_words() {
        let fixture = setup();
        fixture.assistant.launch();
        let missing = ModelPick { id: "missing".into(), ..faux_pick() };
        fixture.assistant.update(Some(true), Some(Some(missing))).await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Stopped).await;
        let error = fixture.assistant.snapshot().await["error"].as_str().unwrap_or("").to_string();
        assert!(error.contains("Model not found: missing"), "{error}");
        // Never another model in its place.
        assert!(replies(&fixture.assistant).is_empty());
    }

    #[tokio::test]
    async fn a_failed_model_call_is_shown_and_the_assistant_stays_ready() {
        let fixture = setup();
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        fixture.assistant.send("fail quota exceeded").await.unwrap();
        until(|| errors(&fixture.assistant).iter().any(|error| error == "quota exceeded")).await;
        until(|| fixture.assistant.state().phase == Phase::Idle).await;
        fixture.assistant.send("next").await.unwrap();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply == "ok: next")).await;
    }

    #[tokio::test]
    async fn the_bridge_opens_only_for_the_running_assistant() {
        let fixture = setup();
        let assistant = &fixture.assistant;
        // Nothing running: no token opens it.
        assert_eq!(assistant.bridge("", "list_workspaces", &json!({})).await.unwrap_err().code, "unauthorized");
        assistant.launch();
        assistant.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        until(|| assistant.state().phase == Phase::Idle).await;
        let token = assistant.runtime_guard().as_ref().unwrap().token.clone();
        assert!(assistant.bridge(&token, "list_workspaces", &json!({})).await.unwrap()["ok"] == true);
        assert_eq!(assistant.bridge(&"0".repeat(token.len()), "list_workspaces", &json!({})).await.unwrap_err().code, "unauthorized");
        // A stopped runtime's token opens nothing.
        assistant.update(Some(false), None).await.unwrap();
        assert_eq!(assistant.bridge(&token, "list_workspaces", &json!({})).await.unwrap_err().code, "unauthorized");
    }

    #[test]
    fn the_assistant_has_no_user_only_tools() {
        let names: Vec<String> = tool_definitions().iter().filter_map(|tool| tool["name"].as_str().map(str::to_string)).collect();
        for name in &names {
            for forbidden in ["approv", "answer", "textguard", "env", "key", "delete_session", "add_workspace", "web_access", "release"] {
                assert!(!name.contains(forbidden), "{name}");
            }
            // Flow is the user's; jouzu's workflow definitions are not Flow.
            assert!(!name.replace("workflow", "").contains("flow"), "{name}");
        }
        assert!(names.contains(&"start_task".to_string()) && names.contains(&"memory_write".to_string()));
    }
}
