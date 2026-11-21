//! The Assistant: Desktop's project coordinator (experimental).
//!
//! A persistent Node process on the Pi SDK (Desktop's own pinned copy), not a
//! jouzu session: no Flow, no TextGuard, no jouzu system prompt. The host
//! owns everything around it: the prompt, the tools (run here, as the
//! built-in client `assistant`), its memory, and when it takes a turn.
//!
//! Turns are decoupled from events. A user message is delivered as soon as
//! the Assistant is idle. Task changes wake it as soon as it is idle, with a
//! short summary; it reads and acknowledges the details itself. Changes that
//! arrive while it works are one wake when it is done. Nothing waits on a
//! timer and nothing is polled: the loop runs when something happens.
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
    /// Reasoning effort as the SDK names it (off … max); absent: the model's own.
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

struct Process {
    child: Child,
    stdin: ChildStdin,
}

pub struct Assistant {
    dir: PathBuf,
    paths: AssistantPaths,
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
            "sdk": { "package": SDK_PACKAGE, "version": SDK_VERSION, "installed": self.sdk_installed() },
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
            Some(self.settings().model.ok_or("Choose a model for the Assistant")?)
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
        prompt.push_str("\n## Skills (load with skill_read before doing that kind of work)\n");
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
                Some("reply") => {
                    self.record("assistant", message["text"].as_str().unwrap_or(""));
                }
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
                if !self.write(json!({ "type": "turn", "turnId": format!("t{turn}"), "text": text })).await {
                    self.set_phase(Phase::Stopped, Some("The Assistant stopped".into()));
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
            "skill_read" => {
                let wanted = string(arguments, "name")?;
                SKILLS
                    .iter()
                    .find(|(name, _)| *name == wanted)
                    .map(|(_, text)| json!({ "skill": text }))
                    .ok_or_else(|| ApiError::bad_request(format!("No skill named {wanted}")))
            }
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
/// projects, memory, history, wakes and skills.
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
        json!({ "name": "skill_read", "description": "Load one of the skills listed in your instructions.", "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }),
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
        let tasks = TaskManager::new(sessions.clone());
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
        let assistant = Assistant::new(home.path(), paths, sessions, tasks.clone(), projects);
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
            .run_tool("start_task", &json!({ "workspace": folder, "text": "Find why login fails on Safari only." }))
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

    /// The real bridge script on the real SDK, with a scripted model. Needs the
    /// SDK installed: JOUZU_ASSISTANT_SDK=<folder with node_modules> cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn the_real_bridge_runs_host_tools_on_the_pinned_sdk() {
        let sdk = PathBuf::from(std::env::var("JOUZU_ASSISTANT_SDK").expect("JOUZU_ASSISTANT_SDK"));
        let fixture = setup();
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
            fixture.assistant.sessions.clone(),
            fixture.tasks.clone(),
            fixture.assistant.projects.clone(),
        );
        // The installed SDK is the pinned one.
        assert!(real.sdk_installed());
        real.launch();
        real.update(Some(true), Some(Some(faux_pick()))).await.unwrap();
        real.send("which folders?").await.unwrap();
        until(|| replies(&real).iter().any(|reply| reply == "One folder.")).await;
    }

    /// Installs the pinned SDK with npm (network). cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn installs_the_pinned_sdk_with_the_bundled_npm() {
        let fixture = setup();
        let mut paths = Assistant::default_paths(fixture._home.path(), &fixture.assistant.sessions);
        paths.node = Some(node());
        let assistant = Assistant::new(
            fixture._home.path(),
            paths,
            fixture.assistant.sessions.clone(),
            fixture.tasks.clone(),
            fixture.assistant.projects.clone(),
        );
        assert!(!assistant.sdk_installed());
        assistant.install_sdk(&node()).await.unwrap();
        assert!(assistant.sdk_installed());
    }

    #[tokio::test]
    async fn skills_are_listed_in_the_prompt_and_load_by_name() {
        let fixture = setup();
        let prompt = fixture.assistant.system_prompt();
        for (name, text) in SKILLS {
            // Line by line: a Windows checkout may have CRLF endings.
            let mut lines = text.lines();
            assert_eq!(lines.next(), Some("---"), "{name} starts with a header");
            assert_eq!(lines.next(), Some(format!("name: {name}").as_str()), "{name} has a matching header");
            assert!(prompt.contains(&format!("- {name}: ")), "{name} is listed");
        }
        let skill = fixture.assistant.run_tool("skill_read", &json!({ "name": "draw-task-views" })).await.unwrap();
        assert!(skill["skill"].as_str().unwrap().contains("jouzu-view"));
        assert!(fixture.assistant.run_tool("skill_read", &json!({ "name": "nope" })).await.is_err());
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
