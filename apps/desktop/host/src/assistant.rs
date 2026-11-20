//! The Assistant: Desktop's project coordinator (experimental).
//!
//! A persistent Node process on the Pi SDK (Desktop's own pinned copy), not a
//! jouzu session: no Flow, no TextGuard, no jouzu system prompt. The host
//! owns everything around it: the prompt, the tools (run here, as the
//! built-in client `assistant`), its memory, and when it takes a turn.
//!
//! Turns are decoupled from events. A user message is delivered as soon as
//! the Assistant is idle. Task changes wake it only when it is idle, after a
//! short quiet period and no sooner than a minimum interval after the last
//! wake, with a summary; it reads and acknowledges the details itself. A
//! hundred tasks ending together are one wake.
//!
//! Nothing restarts it silently: if the process ends, it stays stopped until
//! the user sends a message or turns it on again.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Notify,
};

use crate::{
    mcp::{self, AgentClient},
    policy,
    projects::{Project, ProjectStore},
    session::{ApiError, SessionManager},
    tasks::TaskManager,
};

pub const CLIENT: &str = "assistant";
/// The Pi SDK version Desktop installs for the Assistant: the one jouzu 0.2.5
/// is built on, so auth.json and models.json read the same.
pub const SDK_PACKAGE: &str = "@earendil-works/pi-coding-agent";
pub const SDK_VERSION: &str = "1.5.0";
const SCRIPT: &str = include_str!("../../../../packaging/desktop/assistant/assistant.mjs");
const PROMPT: &str = include_str!("../../../../packaging/desktop/assistant/prompt.md");
pub const SKILLS: &[(&str, &str)] = &[];

const MEMORY_LIMIT: usize = 4096;
const MEMORY_TYPES: [&str; 5] = ["user", "feedback", "project", "decision", "reference"];
const WAKE_ENTRIES: usize = 20;
const TRANSCRIPT_TEXT: usize = 16_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelPick {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    model: Option<ModelPick>,
}

/// How often task changes may wake the Assistant.
#[derive(Clone, Copy, Debug)]
pub struct WakePolicy {
    /// Changes wait this long for more to arrive.
    pub quiet: Duration,
    /// No wake sooner than this after the last one.
    pub min_interval: Duration,
}

impl Default for WakePolicy {
    fn default() -> Self {
        Self { quiet: Duration::from_secs(3), min_interval: Duration::from_secs(30) }
    }
}

/// Where things are. Tests point these at fixtures.
#[derive(Clone)]
pub struct AssistantPaths {
    pub node: Option<PathBuf>,
    /// The folder the SDK is installed into (its `node_modules`).
    pub sdk: PathBuf,
    /// jouzu's agent folder: auth.json and models.json are read from it.
    pub runtime_agent: PathBuf,
    /// A script to run instead of the embedded one (tests).
    pub script: Option<PathBuf>,
    /// A scripted model instead of a real one (tests).
    pub faux: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Off,
    Installing,
    Starting,
    Idle,
    Running,
    Stopped,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Off => "off",
            Phase::Installing => "installing",
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

struct State {
    phase: Phase,
    error: Option<String>,
    /// User messages waiting for the Assistant to be idle.
    queue: VecDeque<String>,
    /// Inbox seq the last wake covered.
    woken_seq: u64,
    /// When new inbox entries were first seen, for the quiet period.
    changes_since: Option<Instant>,
    last_wake: Option<Instant>,
    scheduled: Vec<Wake>,
    turn: u64,
    /// The memory index as the Assistant last saw it.
    memory_seen: String,
}

struct Process {
    child: Child,
    stdin: ChildStdin,
}

pub struct Assistant {
    dir: PathBuf,
    paths: AssistantPaths,
    policy: WakePolicy,
    sessions: Arc<SessionManager>,
    tasks: Arc<TaskManager>,
    projects: Arc<ProjectStore>,
    settings: Mutex<Settings>,
    state: Mutex<State>,
    process: tokio::sync::Mutex<Option<Process>>,
    kick: Notify,
    /// Bumped each start, so a reader of an old process ignores its end.
    generation: std::sync::atomic::AtomicU64,
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
        policy: WakePolicy,
        sessions: Arc<SessionManager>,
        tasks: Arc<TaskManager>,
        projects: Arc<ProjectStore>,
    ) -> Arc<Self> {
        let dir = home.join("assistant");
        let settings = std::fs::read(dir.join("assistant.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            dir,
            paths,
            policy,
            sessions,
            tasks,
            projects,
            settings: Mutex::new(settings),
            state: Mutex::new(State {
                phase: Phase::Off,
                error: None,
                queue: VecDeque::new(),
                woken_seq: 0,
                changes_since: None,
                last_wake: None,
                scheduled: Vec::new(),
                turn: 0,
                memory_seen: String::new(),
            }),
            process: tokio::sync::Mutex::new(None),
            kick: Notify::new(),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// The paths a real host uses.
    pub fn default_paths(home: &Path, sessions: &SessionManager) -> AssistantPaths {
        AssistantPaths {
            node: sessions.node_executable(),
            sdk: home.join("assistant").join("sdk"),
            runtime_agent: sessions.runtime_home().join("agent"),
            script: None,
            faux: None,
        }
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
        state.error = error;
        drop(state);
        self.kick.notify_one();
    }

    fn memory_dir(&self) -> PathBuf {
        self.dir.join("memory")
    }

    fn transcript(&self) -> PathBuf {
        self.dir.join("transcript.jsonl")
    }

    fn record(&self, kind: &str, text: &str) {
        let _ = std::fs::create_dir_all(&self.dir);
        let row = json!({ "at": now_iso(), "kind": kind, "text": cut(text, TRANSCRIPT_TEXT) });
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(self.transcript()) {
            use std::io::Write;
            let _ = writeln!(file, "{row}");
        }
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
            "model": settings.model.clone().or_else(|| self.default_model()),
            "modelChosen": settings.model.is_some(),
            "phase": state.phase.as_str(),
            "error": state.error,
            "queued": state.queue.len(),
            "scheduledWakes": state.scheduled.iter().map(|wake| json!({
                "inSeconds": wake.at.saturating_duration_since(Instant::now()).as_secs(),
                "note": wake.note,
            })).collect::<Vec<_>>(),
            "sdk": { "package": SDK_PACKAGE, "version": SDK_VERSION, "installed": self.sdk_installed() },
        })
    }

    pub async fn update(self: &Arc<Self>, enabled: Option<bool>, model: Option<Option<ModelPick>>) -> Result<Value, ApiError> {
        let (before, after) = {
            let mut settings = self.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let before = settings.clone();
            if let Some(enabled) = enabled {
                settings.enabled = enabled;
            }
            if let Some(model) = model {
                settings.model = model;
            }
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
        if text.is_empty() || text.len() > 16_000 {
            return Err(ApiError::bad_request("Enter a message of at most 16000 bytes"));
        }
        if !self.settings().enabled {
            return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "assistant-off", "Turn the Assistant on first", false));
        }
        let restart = {
            let mut state = self.state();
            state.queue.push_back(text.to_string());
            matches!(state.phase, Phase::Stopped | Phase::Off)
        };
        self.record("user", text);
        if restart {
            let assistant = Arc::clone(self);
            tokio::spawn(async move { assistant.start().await });
        }
        self.kick.notify_one();
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

    fn default_model(&self) -> Option<ModelPick> {
        let settings: Value = std::fs::read(self.paths.runtime_agent.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
        Some(ModelPick {
            provider: settings["defaultProvider"].as_str()?.to_string(),
            id: settings["defaultModel"].as_str()?.to_string(),
        })
    }

    fn sdk_installed(&self) -> bool {
        if self.paths.script.is_some() {
            // A test script brings its own (or no) SDK.
            return true;
        }
        let manifest = self.paths.sdk.join("node_modules").join(SDK_PACKAGE).join("package.json");
        std::fs::read(manifest)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| value["version"] == SDK_VERSION)
    }

    /// Installs the pinned SDK with the Node that came with Desktop.
    async fn install_sdk(&self, node: &Path) -> Result<(), String> {
        let npm = if cfg!(windows) {
            node.parent().map(|dir| dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"))
        } else {
            node.parent()
                .and_then(Path::parent)
                .map(|dir| dir.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"))
        }
        .filter(|path| path.is_file())
        .ok_or("The Node that came with Desktop has no npm")?;
        std::fs::create_dir_all(&self.paths.sdk).map_err(|error| error.to_string())?;
        let manifest = self.paths.sdk.join("package.json");
        if !manifest.is_file() {
            std::fs::write(&manifest, r#"{"name":"jouzu-desktop-assistant","private":true}"#).map_err(|error| error.to_string())?;
        }
        let mut command = Command::new(node);
        command
            .arg(npm)
            .arg("install")
            .arg(format!("{SDK_PACKAGE}@{SDK_VERSION}"))
            .args(["--omit=dev", "--no-audit", "--no-fund", "--save-exact"])
            .current_dir(&self.paths.sdk)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(dir) = node.parent() {
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut paths = vec![dir.to_path_buf()];
            paths.extend(std::env::split_paths(&path));
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = command.output().await.map_err(|error| error.to_string())?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let last = detail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim().to_string();
            return Err(format!("The Assistant's SDK could not be installed: {last}"));
        }
        Ok(())
    }

    async fn start(self: &Arc<Self>) {
        {
            let mut state = self.state();
            if matches!(state.phase, Phase::Installing | Phase::Starting | Phase::Idle | Phase::Running) {
                return;
            }
            state.phase = Phase::Starting;
            state.error = None;
        }
        if let Err(message) = self.spawn().await {
            crate::log(self.sessions.home(), "warn", "assistant.start_failed", json!({ "message": message }));
            self.record("error", &message);
            self.set_phase(Phase::Stopped, Some(message));
        }
    }

    async fn spawn(self: &Arc<Self>) -> Result<(), String> {
        let node = self.paths.node.clone().ok_or("Node is not available to run the Assistant")?;
        if !self.sdk_installed() {
            self.set_phase(Phase::Installing, None);
            self.install_sdk(&node).await?;
            self.set_phase(Phase::Starting, None);
        }
        let model = if self.paths.faux.is_some() {
            None
        } else {
            Some(self.settings().model.or_else(|| self.default_model()).ok_or("Choose a model for the Assistant")?)
        };
        let agent_dir = self.dir.join("agent");
        std::fs::create_dir_all(&agent_dir).map_err(|error| error.to_string())?;
        let script = match &self.paths.script {
            Some(script) => script.clone(),
            None => {
                let path = self.dir.join("assistant.mjs");
                std::fs::write(&path, SCRIPT).map_err(|error| error.to_string())?;
                path
            }
        };
        let mut command = Command::new(&node);
        command
            .arg(&script)
            .current_dir(&agent_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        // Where the sandbox will isolate the Assistant (#197); no change yet.
        policy::launch_profile(&mut command, policy::Launch::Assistant);
        let mut child = command.spawn().map_err(|error| format!("Could not start the Assistant: {error}"))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();
        let start = json!({
            "type": "start",
            "sdk": self.paths.sdk,
            "agentDir": agent_dir,
            "sessionDir": self.dir.join("sessions"),
            "authPath": self.paths.runtime_agent.join("auth.json"),
            "modelsPath": self.paths.runtime_agent.join("models.json"),
            "model": model,
            "systemPrompt": self.system_prompt(),
            "tools": tool_definitions(),
            "faux": self.paths.faux,
        });
        stdin
            .write_all(format!("{start}\n").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        *self.process.lock().await = Some(Process { child, stdin });
        if let Some(stderr) = stderr {
            let home = self.sessions.home().to_path_buf();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    crate::log(&home, "debug", "assistant.stderr", json!({ "line": cut(&line, 2000) }));
                }
            });
        }
        let assistant = Arc::clone(self);
        tokio::spawn(async move { assistant.read_loop(stdout, generation).await });
        Ok(())
    }

    fn system_prompt(&self) -> String {
        let mut prompt = PROMPT.to_string();
        prompt.push_str("\n## Skills\n");
        if SKILLS.is_empty() {
            prompt.push_str("(none yet)\n");
        }
        for (name, text) in SKILLS {
            let summary = text.lines().find(|line| line.starts_with("description:")).unwrap_or("");
            prompt.push_str(&format!("- {name}: {}\n", summary.trim_start_matches("description:").trim()));
        }
        prompt
    }

    async fn write(&self, value: Value) -> bool {
        let mut process = self.process.lock().await;
        let Some(process) = process.as_mut() else { return false };
        process.stdin.write_all(format!("{value}\n").as_bytes()).await.is_ok()
    }

    async fn read_loop(self: Arc<Self>, stdout: tokio::process::ChildStdout, generation: u64) {
        let mut lines = BufReader::new(stdout).lines();
        let mut fatal = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            match message["type"].as_str() {
                Some("ready") => {
                    crate::log(self.sessions.home(), "info", "assistant.ready", json!({ "tools": message["tools"] }));
                    self.set_phase(Phase::Idle, None);
                }
                Some("tool") => {
                    let assistant = Arc::clone(&self);
                    tokio::spawn(async move {
                        let name = message["name"].as_str().unwrap_or("").to_string();
                        let result = assistant.run_tool(&name, &message["arguments"]).await;
                        let (ok, result) = match result {
                            Ok(value) => (true, value),
                            Err(error) => (false, json!({ "error": { "code": error.code, "message": error.message } })),
                        };
                        assistant
                            .write(json!({ "type": "tool_result", "callId": message["callId"], "ok": ok, "result": result }))
                            .await;
                    });
                }
                Some("reply") => self.record("assistant", message["text"].as_str().unwrap_or("")),
                Some("turn_end") => {
                    if message["stopReason"] == "error" {
                        let error = message["error"].as_str().unwrap_or("The turn failed").to_string();
                        self.record("error", &error);
                        self.set_phase(Phase::Idle, Some(error));
                    } else {
                        self.set_phase(Phase::Idle, None);
                    }
                }
                Some("fatal") => fatal = message["message"].as_str().map(str::to_string),
                _ => {}
            }
        }
        if self.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return;
        }
        let message = fatal.unwrap_or_else(|| "The Assistant stopped".to_string());
        if self.state().phase != Phase::Off {
            self.record("error", &message);
            self.stop_process(Phase::Stopped, Some(message)).await;
        }
    }

    async fn stop_process(&self, phase: Phase, error: Option<String>) {
        if let Some(mut process) = self.process.lock().await.take() {
            let _ = process.child.start_kill();
        }
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.set_phase(phase, error);
    }

    /// Delivers what is due whenever the Assistant is idle.
    async fn schedule_loop(self: Arc<Self>) {
        loop {
            tokio::select! {
                _ = self.kick.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
            if let Some(text) = self.next_turn() {
                let turn = {
                    let mut state = self.state();
                    state.turn += 1;
                    state.phase = Phase::Running;
                    state.turn
                };
                if !self.write(json!({ "type": "turn", "turnId": format!("t{turn}"), "text": text })).await {
                    self.set_phase(Phase::Stopped, Some("The Assistant stopped".into()));
                }
            }
        }
    }

    /// The next turn to take, if any: the user first, then a wake.
    fn next_turn(&self) -> Option<String> {
        let inbox = self.tasks.inbox(CLIENT, 0).ok();
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
        let changed = newest > state.woken_seq;
        if changed && state.changes_since.is_none() {
            state.changes_since = Some(now);
        }
        let quiet = state.changes_since.is_some_and(|since| now.duration_since(since) >= self.policy.quiet);
        let spaced = state.last_wake.is_none_or(|last| now.duration_since(last) >= self.policy.min_interval);
        let due: Vec<String> = state
            .scheduled
            .iter()
            .filter(|wake| wake.at <= now)
            .map(|wake| wake.note.clone())
            .collect();
        let inbox_wake = changed && quiet && spaced;
        if !inbox_wake && due.is_empty() {
            return None;
        }
        state.scheduled.retain(|wake| wake.at > now);
        state.last_wake = Some(now);
        let mut text = String::from("[wake]");
        if inbox_wake {
            state.woken_seq = newest;
            state.changes_since = None;
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
                self.projects.save_project(CLIENT, project, id.as_deref())
            }
            "memory_index" => Ok(json!({ "index": self.memory_index_text() })),
            "memory_read" => self.memory_read(string(arguments, "name")?),
            "memory_write" => self.memory_write(arguments),
            "memory_delete" => self.memory_delete(string(arguments, "name")?),
            "memory_search" => self.memory_search(string(arguments, "query")?),
            "history_search" => Ok(self.history_search(string(arguments, "query")?, arguments["limit"].as_u64().unwrap_or(20) as usize)),
            "schedule_wake" => {
                let seconds = arguments["seconds"].as_u64().ok_or_else(|| ApiError::bad_request("seconds is required"))?;
                if !(60..=86_400).contains(&seconds) {
                    return Err(ApiError::bad_request("seconds must be from 60 to 86400"));
                }
                let note = cut(arguments["note"].as_str().unwrap_or(""), 500);
                let mut state = self.state();
                if state.scheduled.len() >= 20 {
                    return Err(ApiError::bad_request("At most 20 wakes can be scheduled"));
                }
                state.scheduled.push(Wake { at: Instant::now() + Duration::from_secs(seconds), note });
                Ok(json!({ "scheduled": state.scheduled.len() }))
            }
            "skill_read" => {
                let wanted = string(arguments, "name")?;
                SKILLS
                    .iter()
                    .find(|(name, _)| *name == wanted)
                    .map(|(_, text)| json!({ "skill": text }))
                    .ok_or_else(|| ApiError::bad_request(format!("No skill named {wanted}")))
            }
            _ => mcp::call_task_tool(&self.tasks, &self.sessions, &client, name, arguments).await,
        }
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
            && name.len() <= 64
            && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !valid {
            return Err(ApiError::bad_request("A memory name is 1-64 characters of a-z, 0-9 and -"));
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
        if text.len() > MEMORY_LIMIT {
            return Err(ApiError::bad_request(format!(
                "A memory is at most {MEMORY_LIMIT} bytes; split it by subject or summarize"
            )));
        }
        let path = self.memory_path(name)?;
        std::fs::create_dir_all(self.memory_dir()).map_err(io)?;
        let existed = path.is_file();
        let count = std::fs::read_dir(self.memory_dir()).map(|entries| entries.count()).unwrap_or(0);
        if !existed && count >= 200 {
            return Err(ApiError::bad_request("At most 200 memories; merge or delete some first"));
        }
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
            let lines: Vec<&str> = text.lines().filter(|line| line.to_lowercase().contains(&query)).take(5).collect();
            if !lines.is_empty() {
                let name = entry.file_name().to_string_lossy().trim_end_matches(".md").to_string();
                hits.push(json!({ "name": name, "lines": lines }));
            }
        }
        Ok(json!({ "hits": hits }))
    }

    fn history_search(&self, query: &str, limit: usize) -> Value {
        let query = query.to_lowercase();
        let rows: Vec<Value> = std::fs::read_to_string(self.transcript())
            .unwrap_or_default()
            .lines()
            .filter(|line| line.to_lowercase().contains(&query))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .map(|mut row| {
                if let Some(text) = row["text"].as_str() {
                    row["text"] = json!(cut(text, 600));
                }
                row
            })
            .collect();
        let start = rows.len().saturating_sub(limit.clamp(1, 50));
        json!({ "hits": rows[start..] })
    }
}

fn string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    arguments[name]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request(format!("{name} is required")))
}

/// What changed, in a few lines: counts by state, then the newest entries.
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
    let shown = entries.len().min(WAKE_ENTRIES);
    for entry in &entries[entries.len() - shown..] {
        text.push_str(&format!(
            "\n- seq {} {} {}",
            entry["seq"], entry["taskId"].as_str().unwrap_or("?"), entry["state"].as_str().unwrap_or("?")
        ));
    }
    if entries.len() > shown {
        text.push_str(&format!("\n({} older entries: read_inbox)", entries.len() - shown));
    }
    text.push_str("\nHandle them, then ack_inbox with the highest seq you handled.");
    text
}

/// Every tool the Assistant has: the task tools agents get over MCP, plus
/// projects, memory, history, wakes and skills.
pub fn tool_definitions() -> Vec<Value> {
    let mut tools = mcp::task_tools();
    let name = json!({ "type": "string", "description": "kebab-case, a-z 0-9 -, at most 64" });
    tools.extend([
        json!({ "name": "list_projects", "description": "The user's projects (name, description, linked folders, sessions, tasks) and the sessions that exist.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "save_project", "description": "Create a project (no id) or replace one (with its id). Omitted lists become empty. Links must name existing workspaces (ids from list_workspaces are paths; use list_projects for workspace ids), sessions and your tasks.", "inputSchema": { "type": "object", "properties": {
            "id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" },
            "workspaceIds": { "type": "array", "items": { "type": "string" } },
            "sessionIds": { "type": "array", "items": { "type": "string" } },
            "taskIds": { "type": "array", "items": { "type": "string" } } }, "required": ["name"] } }),
        json!({ "name": "memory_index", "description": "One line per memory: name (type): description.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "memory_read", "description": "Read one memory.", "inputSchema": { "type": "object", "properties": { "name": name }, "required": ["name"] } }),
        json!({ "name": "memory_write", "description": "Create or replace one memory (one subject per memory, at most 4 KB). type: user, feedback, project, decision or reference. The body says the fact, why it matters and what it does not mean. Never store live task state.", "inputSchema": { "type": "object", "properties": {
            "name": name, "type": { "type": "string", "enum": MEMORY_TYPES }, "description": { "type": "string", "description": "One line, used to decide relevance" }, "body": { "type": "string" } }, "required": ["name", "type", "description", "body"] } }),
        json!({ "name": "memory_delete", "description": "Delete a memory that is wrong or no longer true.", "inputSchema": { "type": "object", "properties": { "name": name }, "required": ["name"] } }),
        json!({ "name": "memory_search", "description": "Find memories containing a text.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } }),
        json!({ "name": "history_search", "description": "Find earlier messages, replies and wakes of your conversation containing a text.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "maximum": 50 } }, "required": ["query"] } }),
        json!({ "name": "schedule_wake", "description": "Be woken after some seconds (60 to 86400) with a note to yourself.", "inputSchema": { "type": "object", "properties": { "seconds": { "type": "integer", "minimum": 60, "maximum": 86400 }, "note": { "type": "string" } }, "required": ["seconds"] } }),
        json!({ "name": "skill_read", "description": "Load one of the skills listed in your instructions.", "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }),
    ]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::RuntimeSpec;

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

    fn node() -> PathBuf {
        which("node").expect("node on PATH")
    }

    fn which(name: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }))
            .find(|path| path.is_file())
    }

    fn setup(policy: WakePolicy) -> Fixture {
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
        let tasks = TaskManager::new(sessions.clone(), 8);
        let projects = ProjectStore::new(sessions.clone(), tasks.clone());
        // The fake writes it in its working folder, the Assistant's agent folder.
        let log = home.path().join("assistant").join("agent").join("turns.log");
        let paths = AssistantPaths {
            node: Some(node()),
            sdk: home.path().join("sdk"),
            runtime_agent: home.path().join("agent"),
            script: Some(fixtures().join("fake-assistant.mjs")),
            faux: Some(json!([])),
        };
        let assistant = Assistant::new(home.path(), paths, policy, sessions, tasks.clone(), projects);
        Fixture { assistant, tasks, workspace, log, _home: home }
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
        let fixture = setup(WakePolicy::default());
        fixture.assistant.launch();
        let refused = fixture.assistant.send("hello").await.unwrap_err();
        assert_eq!(refused.code, "assistant-off");
        fixture.assistant.update(Some(true), None).await.unwrap();
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
    async fn many_tasks_ending_together_wake_the_assistant_once() {
        let fixture = setup(WakePolicy { quiet: Duration::from_millis(1500), min_interval: Duration::from_secs(60) });
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), None).await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Idle).await;
        let folder = fixture.workspace.path().to_string_lossy().into_owned();
        for n in 0..5 {
            fixture.tasks.start(CLIENT, &folder, &format!("job {n}")).unwrap();
        }
        until(|| replies(&fixture.assistant).iter().any(|reply| reply.starts_with("handled"))).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let wakes: Vec<String> = turns(&fixture.log).into_iter().filter(|text| text.starts_with("[wake]")).collect();
        assert_eq!(wakes.len(), 1, "{wakes:?}");
        // The Assistant acknowledged what it handled.
        let left = fixture.tasks.inbox(CLIENT, 0).unwrap()["entries"].as_array().unwrap().len();
        let handled: usize = replies(&fixture.assistant)
            .iter()
            .find_map(|reply| reply.strip_prefix("handled ").and_then(|n| n.parse().ok()))
            .unwrap();
        assert_eq!(handled + left, 5, "one entry per task, none lost");
    }

    #[tokio::test]
    async fn a_stopped_assistant_stays_stopped_until_the_user_writes() {
        let fixture = setup(WakePolicy::default());
        fixture.assistant.launch();
        fixture.assistant.update(Some(true), None).await.unwrap();
        fixture.assistant.send("exit").await.unwrap();
        until(|| fixture.assistant.state().phase == Phase::Stopped).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(fixture.assistant.state().phase, Phase::Stopped);
        fixture.assistant.send("again").await.unwrap();
        until(|| replies(&fixture.assistant).iter().any(|reply| reply == "ok: again")).await;
    }

    #[tokio::test]
    async fn memory_is_one_bounded_file_per_subject() {
        let fixture = setup(WakePolicy::default());
        let assistant = &fixture.assistant;
        let write = |name: &str, body: &str| {
            assistant.memory_write(&json!({ "name": name, "type": "decision", "description": "why we do it", "body": body }))
        };
        write("release-gates", "Only regressions block a candidate.").unwrap();
        assert!(write("../escape", "x").is_err());
        assert!(write("Upper", "x").is_err());
        assert!(write("too-long", &"x".repeat(MEMORY_LIMIT)).is_err());
        assert!(assistant.memory_write(&json!({ "name": "x", "type": "secret", "description": "d", "body": "b" })).is_err());
        assert_eq!(assistant.memory_index_text(), "- release-gates (decision): why we do it");
        assert!(assistant.memory_read("release-gates").unwrap()["text"].as_str().unwrap().contains("regressions"));
        assert_eq!(assistant.memory_search("REGRESSIONS").unwrap()["hits"][0]["name"], "release-gates");
        assistant.memory_delete("release-gates").unwrap();
        assert_eq!(assistant.memory_index_text(), "");
    }

    /// The real bridge script on the real SDK, with a scripted model. Needs the
    /// SDK installed: JOUZU_ASSISTANT_SDK=<folder with node_modules> cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn the_real_bridge_runs_host_tools_on_the_pinned_sdk() {
        let sdk = PathBuf::from(std::env::var("JOUZU_ASSISTANT_SDK").expect("JOUZU_ASSISTANT_SDK"));
        let fixture = setup(WakePolicy::default());
        let paths = AssistantPaths {
            node: Some(node()),
            sdk,
            runtime_agent: fixture._home.path().join("agent"),
            script: None,
            faux: Some(json!([{ "tool": "list_workspaces" }, { "text": "One folder." }])),
        };
        let real = Assistant::new(
            fixture._home.path(),
            paths,
            WakePolicy::default(),
            fixture.assistant.sessions.clone(),
            fixture.tasks.clone(),
            fixture.assistant.projects.clone(),
        );
        // The installed SDK is the pinned one.
        assert!(real.sdk_installed());
        real.launch();
        real.update(Some(true), None).await.unwrap();
        real.send("which folders?").await.unwrap();
        until(|| replies(&real).iter().any(|reply| reply == "One folder.")).await;
    }

    /// Installs the pinned SDK with npm (network). cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn installs_the_pinned_sdk_with_the_bundled_npm() {
        let fixture = setup(WakePolicy::default());
        let mut paths = Assistant::default_paths(fixture._home.path(), &fixture.assistant.sessions);
        paths.node = Some(node());
        let assistant = Assistant::new(
            fixture._home.path(),
            paths,
            WakePolicy::default(),
            fixture.assistant.sessions.clone(),
            fixture.tasks.clone(),
            fixture.assistant.projects.clone(),
        );
        assert!(!assistant.sdk_installed());
        assistant.install_sdk(&node()).await.unwrap();
        assert!(assistant.sdk_installed());
    }

    #[test]
    fn the_assistant_has_no_user_only_tools() {
        let names: Vec<String> = tool_definitions().iter().filter_map(|tool| tool["name"].as_str().map(str::to_string)).collect();
        for name in &names {
            for forbidden in ["approv", "answer", "flow", "textguard", "env", "key", "delete_session", "add_workspace", "web_access"] {
                assert!(!name.contains(forbidden), "{name}");
            }
        }
        assert!(names.contains(&"start_task".to_string()) && names.contains(&"memory_write".to_string()));
    }
}
