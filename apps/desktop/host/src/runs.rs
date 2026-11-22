//! Graphs and runs: the loop engine.
//!
//! A graph is data (JSON): nodes and the edges between them. The engine only
//! interprets it; there is no code in a graph. Three kinds of node:
//!
//! - agent: starts a task (an ordinary session) with a brief, and is done when
//!   the task's turn ended and the files it must deliver exist;
//! - check: runs a command; its exit code decides, and its exit code, stdout
//!   and stderr are all kept;
//! - checkpoint: stops and waits for the user, who approves, sends the run
//!   back to an earlier node with a note, or stops it.
//!
//! Edges carry the result they follow (`done`, `undelivered`, `failed`,
//! `passed`, `approved`) and may say how many attempts of their node must
//! have happened (`attempts`), which is how a graph leaves a loop: "after
//! three failed fixes, ask the user" is an edge in the graph, not a number in
//! the engine. The first edge that matches is taken. When none matches, a
//! good result (done, passed, approved) finishes the run and any other fails
//! it.
//!
//! The engine, not a model, decides where a run goes and what counts as done.
//! It keeps each run in a file and moves only on events (a task ending, a
//! command exiting, the user deciding), so a restart picks runs up where they
//! were. What it did is reported as facts, with the evidence it kept.
//!
//! Graphs are the user's: saved versions are kept and each run records the
//! version it uses, so changing a graph never changes a run already going.
//! The Assistant may propose a graph; it is used only once the user accepts it.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::{
    session::{ApiError, SessionManager},
    tasks::TaskManager,
    connectors::Connectors,
    triggers::{fill, fill_value, Event},
};

/// Graphs that come with Desktop, tuned by us. Installed as the user's
/// version 1; a newer shipped one is installed only over a graph the user
/// has not changed.
const SHIPPED: [&str; 2] = [
    include_str!("../../../../packaging/desktop/graphs/issue-loop.json"),
    include_str!("../../../../packaging/desktop/graphs/qa-release-loop.json"),
];

/// Tasks a run starts are the user's, like tasks started in Desktop.
const TASK_CLIENT: &str = "desktop";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    #[serde(rename_all = "camelCase")]
    Agent {
        /// The folder the task works in (one the user added). Templated.
        workspace: String,
        /// What the task is asked to do. Templated.
        brief: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<Value>,
        /// Files (relative to the folder, templated) that must exist when
        /// the task's turn ends; missing ones make the result `undelivered`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        outputs: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Check {
        workspace: String,
        /// The command, run by the system shell in the folder. Templated.
        run: String,
    },
    /// An action at a connector (e.g. GitHub `read_issue`, `comment`,
    /// `open_pr`). Writing actions run only right after an approved
    /// checkpoint. `args` are templated.
    #[serde(rename_all = "camelCase")]
    Connector {
        connector: String,
        action: String,
        #[serde(default)]
        args: Value,
    },
    #[serde(rename_all = "camelCase")]
    Checkpoint {
        /// The question for the user. Templated.
        ask: String,
        /// What to put in front of the user: files (relative to `workspace`
        /// when given) or text. Templated.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        show: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<String>,
        /// Nodes the user may send the run back to.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        send_back: Vec<String>,
    },
}

impl Node {
    fn results(&self) -> &'static [&'static str] {
        match self {
            Node::Agent { .. } => &["done", "undelivered", "failed"],
            Node::Check { .. } => &["passed", "failed"],
            Node::Connector { .. } => &["done", "failed"],
            Node::Checkpoint { .. } => &["approved"],
        }
    }
}

fn good(result: &str) -> bool {
    matches!(result, "done" | "passed" | "approved")
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub when: String,
    /// Taken only once `from` has had at least this many attempts in the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Set by the host when a version is saved.
    #[serde(default)]
    pub version: u64,
    /// Parameter name -> "string" or "number". All are required.
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    pub start: String,
    pub nodes: BTreeMap<String, Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

impl Graph {
    pub fn check(&self) -> Result<(), ApiError> {
        let bad = |message: String| Err(ApiError::bad_request(message));
        if self.id.is_empty() || !self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return bad("A graph id is letters, digits, - and _".into());
        }
        if self.nodes.is_empty() {
            return bad("A graph has at least one node".into());
        }
        if !self.nodes.contains_key(&self.start) {
            return bad(format!("start names no node: {}", self.start));
        }
        for (name, kind) in &self.params {
            if !matches!(kind.as_str(), "string" | "number") {
                return bad(format!("Parameter {name} is string or number"));
            }
        }
        for (id, node) in &self.nodes {
            if let Node::Checkpoint { send_back, .. } = node {
                if let Some(missing) = send_back.iter().find(|target| !self.nodes.contains_key(*target)) {
                    return bad(format!("{id} sends back to no node: {missing}"));
                }
            }
            if let Node::Agent { model: Some(model), .. } = node {
                if !(model["provider"].is_string() && model["id"].is_string()) {
                    return bad(format!("{id}: model is {{provider, id}}"));
                }
            }
        }
        for edge in &self.edges {
            let Some(from) = self.nodes.get(&edge.from) else {
                return bad(format!("An edge starts at no node: {}", edge.from));
            };
            if !self.nodes.contains_key(&edge.to) {
                return bad(format!("An edge ends at no node: {}", edge.to));
            }
            if !from.results().contains(&edge.when.as_str()) {
                return bad(format!("{} cannot end {}; it ends {}", edge.from, edge.when, from.results().join(", ")));
            }
            if edge.attempts == Some(0) {
                return bad("attempts is at least 1".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    /// A node is working (a task or a command).
    Running,
    /// A checkpoint waits for the user.
    Waiting,
    Finished,
    Failed,
    Stopped,
}

impl RunState {
    fn ended(self) -> bool {
        matches!(self, RunState::Finished | RunState::Failed | RunState::Stopped)
    }

    fn as_str(self) -> &'static str {
        match self {
            RunState::Running => "running",
            RunState::Waiting => "waiting",
            RunState::Finished => "finished",
            RunState::Failed => "failed",
            RunState::Stopped => "stopped",
        }
    }
}

/// One go at one node.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub node: String,
    /// The how-manyth attempt of this node in the run, from 1.
    pub n: u64,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// What the engine kept: task id, session, files found or missing, exit
    /// code and where stdout/stderr are, the question, the user's decision.
    #[serde(default)]
    pub evidence: Value,
    /// The user's note when they sent the run back here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub run_id: String,
    pub graph_id: String,
    pub graph_version: u64,
    pub params: Map<String, Value>,
    pub state: RunState,
    pub attempts: Vec<Attempt>,
    /// Who started it: {"by": "user" | "assistant" | "trigger", ...}.
    pub started_by: Value,
    /// Triggers that led here; passed on to the tasks it starts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggered_by: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Why the run failed or was stopped, in the engine's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Run {
    fn current(&self) -> Option<&Attempt> {
        self.attempts.last().filter(|attempt| attempt.result.is_none())
    }

    fn count(&self, node: &str) -> u64 {
        self.attempts.iter().filter(|attempt| attempt.node == node).count() as u64
    }
}

/// How a report reaches the user (the Assistant's pane): the facts, and the
/// same in English words for logs and readers without the UI's texts.
type Reporter = Box<dyn Fn(Value, String) + Send + Sync>;

pub struct Runs {
    home: PathBuf,
    sessions: Arc<SessionManager>,
    tasks: Arc<TaskManager>,
    runs: Mutex<HashMap<String, Run>>,
    /// Commands running for check nodes: dropping the sender stops one.
    checks: Mutex<HashMap<String, oneshot::Sender<()>>>,
    reporter: OnceLock<Reporter>,
    ended: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
    /// Tasks that ended before their run recorded them, by task id.
    early: Mutex<HashMap<String, String>>,
    connectors: OnceLock<Arc<Connectors>>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_id(prefix: &str) -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}{hex}")
}

fn not_found(what: &'static str, message: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, what, message.to_string(), false)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ApiError::internal(error.to_string()))?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(value).unwrap_or_default())
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// "approve", "sendBack" or "stop".
    pub decision: String,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl Runs {
    pub fn new(home: &Path, sessions: Arc<SessionManager>, tasks: Arc<TaskManager>) -> Arc<Self> {
        let dir = home.join("runs");
        let runs = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| std::fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice::<Run>(&bytes).ok())
            .map(|run| (run.run_id.clone(), run))
            .collect();
        let engine = Arc::new(Self {
            home: home.to_path_buf(),
            sessions,
            tasks,
            runs: Mutex::new(runs),
            checks: Mutex::new(HashMap::new()),
            reporter: OnceLock::new(),
            ended: Mutex::new(Vec::new()),
            early: Mutex::new(HashMap::new()),
            connectors: OnceLock::new(),
        });
        engine.install_shipped();
        engine
    }

    /// Puts the shipped graphs in place: new ones as version 1, newer ones
    /// over a graph the user has not changed since the last shipped copy.
    fn install_shipped(&self) {
        for text in SHIPPED {
            let Ok(graph) = serde_json::from_str::<Graph>(text) else { continue };
            let copy = self.graphs_dir().join(&graph.id).join("shipped.json");
            let last_shipped: Option<Graph> = std::fs::read(&copy).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
            let same = |a: &Graph, b: &Graph| Graph { version: 0, ..a.clone() } == Graph { version: 0, ..b.clone() };
            if last_shipped.as_ref().is_some_and(|last| same(last, &graph)) {
                continue;
            }
            let latest = self.graph(&graph.id, None).ok();
            let untouched = match (&latest, &last_shipped) {
                (None, _) => true,
                (Some(latest), Some(last)) => same(latest, last),
                (Some(_), None) => false,
            };
            if untouched && self.save_graph(graph.clone()).is_ok() {
                let _ = write_json(&copy, &graph);
            }
        }
    }

    /// The connectors `connector` steps act through. Set once.
    pub fn set_connectors(&self, connectors: Arc<Connectors>) {
        let _ = self.connectors.set(connectors);
    }

    pub fn set_reporter(&self, reporter: impl Fn(Value, String) + Send + Sync + 'static) {
        let _ = self.reporter.set(Box::new(reporter));
    }

    /// Runs ending, as events ("run.ended"), for triggers.
    pub fn subscribe_ended(&self) -> mpsc::UnboundedReceiver<Event> {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.ended.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(sender);
        receiver
    }

    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn early(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.early.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn graphs_dir(&self) -> PathBuf {
        self.home.join("graphs")
    }

    fn run_file(&self, run_id: &str) -> PathBuf {
        self.home.join("runs").join(format!("{run_id}.json"))
    }

    fn evidence_dir(&self, run_id: &str) -> PathBuf {
        self.home.join("runs").join(run_id)
    }

    fn save_run(&self, run: &Run) {
        let _ = write_json(&self.run_file(&run.run_id), run);
        self.sessions.publish_control("runs.changed", json!({ "runId": run.run_id, "state": run.state.as_str() }));
    }

    fn report(&self, facts: Value, text: String) {
        crate::log(self.sessions.home(), "info", "run.report", json!({ "facts": facts, "text": text }));
        if let Some(reporter) = self.reporter.get() {
            reporter(facts, text);
        }
    }

    // ---- graphs ----

    fn versions(&self, id: &str) -> Vec<u64> {
        let mut versions: Vec<u64> = std::fs::read_dir(self.graphs_dir().join(id))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.strip_prefix('v')?.strip_suffix(".json")?.parse().ok()
            })
            .collect();
        versions.sort_unstable();
        versions
    }

    /// A saved version of a graph, the latest when `version` is None.
    pub fn graph(&self, id: &str, version: Option<u64>) -> Result<Graph, ApiError> {
        let version = match version {
            Some(version) => version,
            None => *self.versions(id).last().ok_or_else(|| not_found("graph-not-found", "No such graph"))?,
        };
        let bytes = std::fs::read(self.graphs_dir().join(id).join(format!("v{version}.json")))
            .map_err(|_| not_found("graph-not-found", "No such graph version"))?;
        serde_json::from_slice(&bytes).map_err(|error| ApiError::internal(format!("Graph file unreadable: {error}")))
    }

    pub fn list_graphs(&self) -> Value {
        let mut ids: Vec<String> = std::fs::read_dir(self.graphs_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        ids.sort();
        let graphs: Vec<Value> = ids
            .iter()
            .map(|id| {
                let latest = self.graph(id, None).ok();
                json!({
                    "id": id,
                    "name": latest.as_ref().map(|graph| graph.name.clone()),
                    "version": latest.as_ref().map(|graph| graph.version),
                    "versions": self.versions(id),
                    "proposed": self.graphs_dir().join(id).join("proposed.json").exists(),
                })
            })
            .collect();
        json!({ "graphs": graphs })
    }

    /// The user saves a graph: a new version. Older versions stay.
    pub fn save_graph(&self, mut graph: Graph) -> Result<Graph, ApiError> {
        graph.check()?;
        graph.version = self.versions(&graph.id).last().copied().unwrap_or(0) + 1;
        write_json(&self.graphs_dir().join(&graph.id).join(format!("v{}.json", graph.version)), &graph)?;
        self.sessions.publish_control("graphs.changed", json!({ "id": graph.id, "version": graph.version }));
        Ok(graph)
    }

    /// The Assistant proposes a graph. Nothing uses it until the user accepts.
    pub fn propose_graph(&self, mut graph: Graph) -> Result<Value, ApiError> {
        graph.check()?;
        graph.version = 0;
        write_json(&self.graphs_dir().join(&graph.id).join("proposed.json"), &graph)?;
        self.sessions.publish_control("graphs.changed", json!({ "id": graph.id, "proposed": true }));
        Ok(json!({ "id": graph.id, "state": "proposed" }))
    }

    pub fn proposal(&self, id: &str) -> Result<Graph, ApiError> {
        let bytes = std::fs::read(self.graphs_dir().join(id).join("proposed.json"))
            .map_err(|_| not_found("proposal-not-found", "No proposed graph"))?;
        serde_json::from_slice(&bytes).map_err(|error| ApiError::internal(error.to_string()))
    }

    /// The user accepts the proposal: it becomes the next version.
    pub fn accept_proposal(&self, id: &str) -> Result<Graph, ApiError> {
        let graph = self.save_graph(self.proposal(id)?)?;
        let _ = std::fs::remove_file(self.graphs_dir().join(id).join("proposed.json"));
        Ok(graph)
    }

    pub fn reject_proposal(&self, id: &str) -> Result<(), ApiError> {
        std::fs::remove_file(self.graphs_dir().join(id).join("proposed.json"))
            .map_err(|_| not_found("proposal-not-found", "No proposed graph"))?;
        self.sessions.publish_control("graphs.changed", json!({ "id": id, "proposed": false }));
        Ok(())
    }

    // ---- runs ----

    pub fn list(&self) -> Value {
        let mut runs: Vec<Value> = self.runs().values().map(|run| self.view(run)).collect();
        runs.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        json!({ "runs": runs })
    }

    pub fn get(&self, run_id: &str) -> Result<Value, ApiError> {
        self.runs().get(run_id).map(|run| self.view(run)).ok_or_else(|| not_found("run-not-found", "No such run"))
    }

    /// A run as the engine knows it, with where it is and who it waits on.
    fn view(&self, run: &Run) -> Value {
        let mut value = serde_json::to_value(run).unwrap_or(Value::Null);
        let current = run.current();
        value["current"] = json!(current.map(|attempt| &attempt.node));
        value["since"] = json!(current.map(|attempt| &attempt.started_at));
        value["waitingOn"] = json!(match (run.state, current) {
            (RunState::Waiting, _) => Some("user"),
            (RunState::Running, Some(attempt)) if attempt.evidence["taskId"].is_string() => Some("task"),
            (RunState::Running, Some(attempt)) if attempt.evidence["connector"].is_string() => Some("connector"),
            (RunState::Running, Some(_)) => Some("check"),
            _ => None,
        });
        value
    }

    /// Checkpoints waiting for the user: the user's to-dos.
    pub fn todos(&self) -> Value {
        let mut todos: Vec<Value> = self
            .runs()
            .values()
            .filter(|run| run.state == RunState::Waiting)
            .filter_map(|run| {
                let attempt = run.current()?;
                Some(json!({
                    "runId": run.run_id,
                    "graphId": run.graph_id,
                    "node": attempt.node,
                    "since": attempt.started_at,
                    "ask": attempt.evidence["ask"],
                    "show": attempt.evidence["show"],
                    "sendBack": attempt.evidence["sendBack"],
                    "done": run.attempts.iter().filter(|done| done.result.is_some()).map(|done| json!({
                        "node": done.node, "n": done.n, "result": done.result, "evidence": done.evidence,
                    })).collect::<Vec<_>>(),
                }))
            })
            .collect();
        todos.sort_by(|a, b| a["since"].as_str().cmp(&b["since"].as_str()));
        json!({ "todos": todos })
    }

    /// Starts a run of the graph's latest version (or `version`).
    pub fn start(
        self: &Arc<Self>,
        graph_id: &str,
        version: Option<u64>,
        params: Map<String, Value>,
        started_by: Value,
        triggered_by: Vec<String>,
    ) -> Result<Value, ApiError> {
        let graph = self.graph(graph_id, version)?;
        for (name, kind) in &graph.params {
            let ok = match (kind.as_str(), params.get(name)) {
                ("string", Some(Value::String(_))) => true,
                ("number", Some(Value::Number(_))) => true,
                _ => false,
            };
            if !ok {
                return Err(ApiError::bad_request(format!("Parameter {name} ({kind}) is required")));
            }
        }
        let run = Run {
            run_id: new_id("run-"),
            graph_id: graph.id.clone(),
            graph_version: graph.version,
            params,
            state: RunState::Running,
            attempts: Vec::new(),
            started_by,
            triggered_by,
            created_at: now_iso(),
            ended_at: None,
            reason: None,
        };
        let run_id = run.run_id.clone();
        self.runs().insert(run_id.clone(), run);
        self.enter(&run_id, &graph, &graph.start, None);
        self.get(&run_id)
    }

    /// The template fields of a run: its parameters, its id, where its
    /// evidence is, and the note it was sent back with.
    fn fields(&self, run: &Run, note: Option<&str>) -> Value {
        let mut fields = Value::Object(run.params.clone());
        fields["runId"] = json!(run.run_id);
        fields["evidence"] = json!(self.evidence_dir(&run.run_id).to_string_lossy());
        fields["note"] = json!(note.unwrap_or(""));
        fields
    }

    /// Begins a new attempt at `node`.
    fn enter(self: &Arc<Self>, run_id: &str, graph: &Graph, node_id: &str, note: Option<String>) {
        let Some(node) = graph.nodes.get(node_id).cloned() else {
            self.end(run_id, RunState::Failed, Some(format!("The graph has no node {node_id}")));
            return;
        };
        let (fields, n, chain, may_write) = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(run_id) else { return };
            let n = run.count(node_id) + 1;
            // Public writes only right after the user approved a checkpoint.
            let may_write = run.attempts.last().is_some_and(|last| {
                last.result.as_deref() == Some("approved")
                    && matches!(graph.nodes.get(&last.node), Some(Node::Checkpoint { .. }))
            });
            run.attempts.push(Attempt {
                node: node_id.to_string(),
                n,
                started_at: now_iso(),
                note: note.clone(),
                evidence: json!({}),
                ..Default::default()
            });
            run.state = if matches!(node, Node::Checkpoint { .. }) { RunState::Waiting } else { RunState::Running };
            (self.fields(run, note.as_deref()), n, run.triggered_by.clone(), may_write)
        };
        let started: Result<Value, String> = match &node {
            Node::Agent { workspace, brief, model, .. } => (|| {
                let workspace = fill(workspace, &fields)?;
                let mut text = fill(brief, &fields)?;
                if let Some(note) = note.as_deref().filter(|note| !note.trim().is_empty()) {
                    text.push_str(&format!("\n\nThe user sent this step back with this note:\n{note}"));
                }
                let task = self
                    .tasks
                    .start_triggered(TASK_CLIENT, &workspace, &text, model.clone(), chain)
                    .map_err(|error| error.message)?;
                Ok(json!({ "taskId": task["taskId"], "workspace": workspace }))
            })(),
            Node::Check { workspace, run } => (|| {
                let workspace = fill(workspace, &fields)?;
                let command = fill(run, &fields)?;
                let dir = self.evidence_dir(run_id).join(format!("{node_id}-{n}"));
                Ok(json!({ "command": command, "workspace": workspace, "dir": dir.to_string_lossy() }))
            })(),
            Node::Connector { connector, action, args } => (|| {
                let args = fill_value(args, &fields)?;
                let dir = self.evidence_dir(run_id).join(format!("{node_id}-{n}"));
                Ok(json!({ "connector": connector, "action": action, "args": args, "mayWrite": may_write, "dir": dir.to_string_lossy() }))
            })(),
            Node::Checkpoint { ask, show, workspace, send_back } => (|| {
                let ask = fill(ask, &fields)?;
                let base = workspace.as_deref().map(|workspace| fill(workspace, &fields)).transpose()?;
                let show = show
                    .iter()
                    .map(|item| {
                        let item = fill(item, &fields)?;
                        Ok(match &base {
                            Some(base) => json!({ "path": Path::new(base).join(&item).to_string_lossy(), "label": item }),
                            None => json!({ "text": item }),
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(json!({ "ask": ask, "show": show, "sendBack": send_back }))
            })(),
        };
        match started {
            Ok(evidence) => {
                let waiting = matches!(node, Node::Checkpoint { .. });
                let run = {
                    let mut runs = self.runs();
                    let Some(run) = runs.get_mut(run_id) else { return };
                    if let Some(attempt) = run.attempts.last_mut() {
                        attempt.evidence = evidence.clone();
                    }
                    run.clone()
                };
                self.save_run(&run);
                // Started only now that the attempt holds what identifies it,
                // so its end always finds it.
                if let Node::Check { .. } = node {
                    let (workspace, command, dir) = (
                        evidence["workspace"].as_str().unwrap_or_default(),
                        evidence["command"].as_str().unwrap_or_default(),
                        PathBuf::from(evidence["dir"].as_str().unwrap_or_default()),
                    );
                    self.spawn_check(run_id, workspace, command, &dir);
                }
                if let Node::Connector { connector, action, .. } = &node {
                    let dir = PathBuf::from(evidence["dir"].as_str().unwrap_or_default());
                    self.spawn_connector(run_id, connector, action, evidence["args"].clone(), may_write, dir);
                }
                if let Some(task) = evidence["taskId"].as_str() {
                    let early = self.early().remove(task);
                    if let Some(state) = early {
                        self.task_ended(task, &state);
                    }
                }
                if waiting {
                    let ask = evidence["ask"].as_str().unwrap_or("");
                    self.report(
                        json!({ "type": "waiting", "runId": run.run_id, "graphId": run.graph_id, "node": node_id, "ask": ask, "n": n }),
                        format!("Run {} ({}) waits for you at {node_id} (time {n}): {ask}", run.run_id, run.graph_id),
                    );
                }
            }
            Err(message) => {
                // The node could not start: that attempt failed, and the graph
                // decides what follows, as for any failure.
                self.finish_attempt(run_id, "failed", json!({ "error": message }));
            }
        }
    }

    /// The answer is kept as `answer.json` in the step's evidence folder, so
    /// later steps can read it ({{evidence}}/<step>-<n>/answer.json).
    fn spawn_connector(self: &Arc<Self>, run_id: &str, connector: &str, action: &str, args: Value, may_write: bool, dir: PathBuf) {
        let runs = Arc::clone(self);
        let (run_id, connector, action) = (run_id.to_string(), connector.to_string(), action.to_string());
        tokio::spawn(async move {
            let outcome = match runs.connectors.get() {
                Some(connectors) => connectors.act(&connector, &action, &args, may_write).await,
                None => Err("Connectors are not available".into()),
            };
            match outcome {
                Ok(answer) => {
                    let file = dir.join("answer.json");
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(&file, serde_json::to_vec_pretty(&answer).unwrap_or_default());
                    runs.finish_attempt(&run_id, "done", json!({ "answer": answer, "answerFile": file.to_string_lossy() }))
                }
                Err(error) => runs.finish_attempt(&run_id, "failed", json!({ "error": error })),
            }
        });
    }

    fn spawn_check(self: &Arc<Self>, run_id: &str, workspace: &str, command: &str, dir: &Path) {
        let (stop, stopped) = oneshot::channel::<()>();
        self.checks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(run_id.to_string(), stop);
        let runs = Arc::clone(self);
        let (run_id, workspace, command, dir) = (run_id.to_string(), workspace.to_string(), command.to_string(), dir.to_path_buf());
        tokio::spawn(async move {
            let mut shell = if cfg!(windows) {
                // Passed to cmd as typed: Rust's argument quoting turns `"` into
                // `\"`, which cmd does not understand. /S /C "..." strips exactly
                // the outer quotes and runs the rest as the user wrote it.
                let mut shell = tokio::process::Command::new("cmd");
                #[cfg(windows)]
                shell.raw_arg(format!("/S /C \"{command}\""));
                shell
            } else {
                let mut shell = tokio::process::Command::new("sh");
                shell.arg("-c").arg(&command);
                shell
            };
            shell
                .current_dir(&workspace)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let output = match shell.spawn() {
                Ok(child) => {
                    tokio::select! {
                        output = child.wait_with_output() => output,
                        // Stopped: dropping the child ends the command.
                        _ = stopped => return,
                    }
                }
                Err(error) => Err(error),
            };
            runs.checks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&run_id);
            let _ = std::fs::create_dir_all(&dir);
            let evidence = match output {
                Ok(output) => {
                    let _ = std::fs::write(dir.join("stdout.txt"), &output.stdout);
                    let _ = std::fs::write(dir.join("stderr.txt"), &output.stderr);
                    json!({
                        "exitCode": output.status.code(),
                        "stdout": dir.join("stdout.txt").to_string_lossy(),
                        "stderr": dir.join("stderr.txt").to_string_lossy(),
                    })
                }
                Err(error) => json!({ "error": format!("The command did not start: {error}") }),
            };
            let result = if evidence["exitCode"] == json!(0) { "passed" } else { "failed" };
            runs.finish_attempt(&run_id, result, evidence);
        });
    }

    /// A task ended: if it is a run's current agent node, judge it.
    pub fn task_ended(self: &Arc<Self>, task_id: &str, state: &str) {
        let found = self.runs().values().find_map(|run| {
            let attempt = run.current()?;
            (run.state == RunState::Running && attempt.evidence["taskId"] == task_id).then(|| (run.run_id.clone(), run.graph_id.clone(), run.graph_version, attempt.node.clone(), run.clone()))
        });
        let Some((run_id, graph_id, version, node_id, run)) = found else {
            // A task a run is still recording (it ended at once): kept for it.
            self.early().insert(task_id.to_string(), state.to_string());
            return;
        };
        let task = self.tasks.get(TASK_CLIENT, task_id).unwrap_or(Value::Null);
        let mut evidence = json!({
            "taskId": task_id,
            "taskState": state,
            "sessionPath": task["sessionPath"],
            "model": task["model"],
            "failure": task["failure"],
        });
        let result = if state != "finished" {
            "failed"
        } else {
            match self.graph(&graph_id, Some(version)).ok().and_then(|graph| graph.nodes.get(&node_id).cloned()) {
                Some(Node::Agent { workspace, outputs, .. }) => {
                    let fields = self.fields(&run, run.current().and_then(|attempt| attempt.note.as_deref()));
                    let base = fill(&workspace, &fields).unwrap_or(workspace);
                    let mut found = Vec::new();
                    let mut missing = Vec::new();
                    for output in &outputs {
                        let path = fill(output, &fields).unwrap_or_else(|_| output.clone());
                        let full = Path::new(&base).join(&path);
                        // Written in this attempt: a file left by an earlier one does not count.
                        let started = run.current().and_then(|attempt| chrono::DateTime::parse_from_rfc3339(&attempt.started_at).ok());
                        let fresh = std::fs::metadata(&full).and_then(|meta| meta.modified()).ok().is_some_and(|modified| {
                            started.is_none_or(|started| chrono::DateTime::<Utc>::from(modified) >= started.with_timezone(&Utc) - chrono::Duration::seconds(1))
                        });
                        if fresh {
                            found.push(full.to_string_lossy().into_owned());
                        } else {
                            missing.push(path);
                        }
                    }
                    evidence["outputs"] = json!(found);
                    evidence["missing"] = json!(missing);
                    if missing.is_empty() { "done" } else { "undelivered" }
                }
                _ => "failed",
            }
        };
        self.finish_attempt(&run_id, result, evidence);
    }

    /// Ends the current attempt with `result` and moves the run on.
    fn finish_attempt(self: &Arc<Self>, run_id: &str, result: &str, evidence: Value) {
        let (graph_id, version, node_id, count) = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(run_id) else { return };
            if run.state.ended() {
                return;
            }
            let count_node;
            {
                let Some(attempt) = run.attempts.last_mut().filter(|attempt| attempt.result.is_none()) else { return };
                attempt.result = Some(result.to_string());
                attempt.ended_at = Some(now_iso());
                if let (Value::Object(kept), Value::Object(more)) = (&mut attempt.evidence, evidence) {
                    kept.extend(more);
                }
                count_node = attempt.node.clone();
            }
            let count = run.count(&count_node);
            let snapshot = run.clone();
            drop(runs);
            self.save_run(&snapshot);
            (snapshot.graph_id, snapshot.graph_version, count_node, count)
        };
        let graph = match self.graph(&graph_id, Some(version)) {
            Ok(graph) => graph,
            Err(error) => {
                self.end(run_id, RunState::Failed, Some(format!("The graph version it runs on is gone: {}", error.message)));
                return;
            }
        };
        if !good(result) {
            self.report(
                json!({ "type": "step", "runId": run_id, "graphId": graph_id, "node": node_id, "result": result, "n": count }),
                format!("Run {run_id} ({graph_id}): {node_id} ended {result} (attempt {count})."),
            );
        }
        let next = graph
            .edges
            .iter()
            .find(|edge| edge.from == node_id && edge.when == result && edge.attempts.is_none_or(|at_least| count >= at_least))
            .map(|edge| edge.to.clone());
        match next {
            Some(to) => self.enter(run_id, &graph, &to, None),
            None if good(result) => self.end(run_id, RunState::Finished, None),
            None => self.end(run_id, RunState::Failed, Some(format!("{node_id} ended {result} and the graph has no step for that"))),
        }
    }

    fn end(&self, run_id: &str, state: RunState, reason: Option<String>) {
        let run = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(run_id) else { return };
            run.state = state;
            run.ended_at = Some(now_iso());
            run.reason = reason.clone();
            run.clone()
        };
        self.save_run(&run);
        self.report(
            json!({ "type": "ended", "runId": run_id, "graphId": run.graph_id, "state": state.as_str(), "reason": reason }),
            match &reason {
                Some(reason) => format!("Run {run_id} ({}) {}: {reason}", run.graph_id, state.as_str()),
                None => format!("Run {run_id} ({}) {}.", run.graph_id, state.as_str()),
            },
        );
        let event = Event {
            id: format!("run.ended:{run_id}"),
            kind: "run.ended".into(),
            at: now_iso(),
            fields: json!({ "runId": run_id, "graphId": run.graph_id, "state": state.as_str(), "triggeredBy": run.triggered_by }),
        };
        self.ended.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|listener| listener.send(event.clone()).is_ok());
    }

    /// The user's decision at a checkpoint. Only the user: agents and the
    /// Assistant have no way here.
    pub fn decide(self: &Arc<Self>, run_id: &str, decision: Decision) -> Result<Value, ApiError> {
        let (graph, node_id, send_back) = {
            let runs = self.runs();
            let run = runs.get(run_id).ok_or_else(|| not_found("run-not-found", "No such run"))?;
            let attempt = run.current().filter(|_| run.state == RunState::Waiting).ok_or_else(|| {
                ApiError::new(StatusCode::CONFLICT, "not-waiting", "This run is not waiting for you", false)
            })?;
            let send_back: Vec<String> = serde_json::from_value(attempt.evidence["sendBack"].clone()).unwrap_or_default();
            (self.graph(&run.graph_id, Some(run.graph_version))?, attempt.node.clone(), send_back)
        };
        let note = decision.note.clone().filter(|note| !note.trim().is_empty());
        let record = json!({ "decision": decision.decision, "node": decision.node, "note": note, "at": now_iso() });
        match decision.decision.as_str() {
            "approve" => self.finish_attempt(run_id, "approved", json!({ "decided": record })),
            "sendBack" => {
                let target = decision.node.clone().ok_or_else(|| ApiError::bad_request("Send back to which step?"))?;
                if !send_back.contains(&target) {
                    return Err(ApiError::bad_request(format!("{node_id} can send back to {}", send_back.join(", "))));
                }
                {
                    let mut runs = self.runs();
                    if let Some(attempt) = runs.get_mut(run_id).and_then(|run| run.attempts.last_mut()) {
                        attempt.result = Some("sentBack".into());
                        attempt.ended_at = Some(now_iso());
                        attempt.evidence["decided"] = record;
                    }
                }
                self.enter(run_id, &graph, &target, note);
            }
            "stop" => {
                {
                    let mut runs = self.runs();
                    if let Some(attempt) = runs.get_mut(run_id).and_then(|run| run.attempts.last_mut()) {
                        attempt.result = Some("stopped".into());
                        attempt.ended_at = Some(now_iso());
                        attempt.evidence["decided"] = record;
                    }
                }
                self.end(run_id, RunState::Stopped, Some(format!("you stopped it at {node_id}")));
            }
            other => return Err(ApiError::bad_request(format!("{other}: decide approve, sendBack or stop"))),
        }
        self.get(run_id)
    }

    /// The user stops a run: its task and command stop with it.
    pub fn stop(self: &Arc<Self>, run_id: &str) -> Result<Value, ApiError> {
        let task = {
            let mut runs = self.runs();
            let run = runs.get_mut(run_id).ok_or_else(|| not_found("run-not-found", "No such run"))?;
            if run.state.ended() {
                return Err(ApiError::new(StatusCode::CONFLICT, "run-ended", "This run has ended", false));
            }
            let attempt = run.attempts.last_mut().filter(|attempt| attempt.result.is_none());
            attempt.and_then(|attempt| {
                attempt.result = Some("stopped".into());
                attempt.ended_at = Some(now_iso());
                attempt.evidence["taskId"].as_str().map(str::to_string)
            })
        };
        self.checks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(run_id);
        if let Some(task) = task {
            let _ = self.tasks.stop(TASK_CLIENT, &task);
        }
        self.end(run_id, RunState::Stopped, Some("you stopped it".into()));
        self.get(run_id)
    }

    /// Listens for tasks ending and picks up runs the host left mid-way.
    pub fn launch(self: &Arc<Self>) {
        let mut ended = self.tasks.subscribe_ended();
        let runs = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = ended.recv().await {
                if let (Some(task), Some(state)) = (event.fields["taskId"].as_str(), event.fields["state"].as_str()) {
                    runs.task_ended(task, state);
                }
            }
        });
        let going: Vec<(String, Attempt)> = self
            .runs()
            .values()
            .filter(|run| run.state == RunState::Running)
            .filter_map(|run| Some((run.run_id.clone(), run.current()?.clone())))
            .collect();
        for (run_id, attempt) in going {
            if let Some(task) = attempt.evidence["taskId"].as_str() {
                // A task that ended while the host was off is judged now.
                let state = self.tasks.get(TASK_CLIENT, task).ok().and_then(|view| view["state"].as_str().map(str::to_string));
                if let Some(state) = state.filter(|state| matches!(state.as_str(), "finished" | "failed" | "stopped")) {
                    self.task_ended(task, &state);
                }
            } else if attempt.evidence["connector"].is_string() {
                // An outside action may have happened: never sent twice.
                self.finish_attempt(&run_id, "failed", json!({ "error": "The host stopped during this action; it was not repeated. Check the service before running it again." }));
            } else {
                // A command cut off by the host stopping: it runs again.
                let graph = {
                    let mut runs = self.runs();
                    let Some(run) = runs.get_mut(&run_id) else { continue };
                    if let Some(cut) = run.attempts.last_mut() {
                        cut.result = Some("interrupted".into());
                        cut.ended_at = Some(now_iso());
                        cut.evidence["error"] = json!("The host stopped while the command ran");
                    }
                    self.graph(&run.graph_id, Some(run.graph_version))
                };
                match graph {
                    Ok(graph) => self.enter(&run_id, &graph, &attempt.node, attempt.note.clone()),
                    Err(error) => self.end(&run_id, RunState::Failed, Some(error.message)),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::RuntimeSpec;

    struct Fixture {
        runs: Arc<Runs>,
        reports: Arc<Mutex<Vec<String>>>,
        folder: String,
        home: tempfile::TempDir,
        _workspace: tempfile::TempDir,
    }

    fn setup() -> Fixture {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionManager::new(
            Some(RuntimeSpec::node_script(&fixture)),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            None,
        ));
        let folder = workspace.path().to_string_lossy().into_owned();
        sessions.add_workspaces(std::slice::from_ref(&folder)).unwrap();
        let tasks = TaskManager::new(sessions.clone());
        let runs = Runs::new(home.path(), sessions, tasks);
        let reports = Arc::new(Mutex::new(Vec::new()));
        let sink = reports.clone();
        runs.set_reporter(move |_, text| sink.lock().unwrap().push(text));
        runs.launch();
        Fixture { runs, reports, folder, home, _workspace: workspace }
    }

    fn graph(value: Value) -> Graph {
        serde_json::from_value(value).unwrap()
    }

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    async fn until_state(runs: &Runs, run_id: &str, state: &str) -> Value {
        for _ in 0..400 {
            let run = runs.get(run_id).unwrap();
            if run["state"] == state {
                return run;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("{run_id} never became {state}: {}", runs.get(run_id).unwrap());
    }

    fn sleep_command() -> &'static str {
        if cfg!(windows) { "ping -n 60 127.0.0.1" } else { "sleep 60" }
    }

    fn three_steps(folder: &str) -> Graph {
        graph(json!({
            "id": "three", "name": "Write, test, approve",
            "params": { "topic": "string" },
            "start": "write",
            "nodes": {
                "write": { "kind": "agent", "workspace": folder, "brief": "Write about {{topic}} in note.txt", "outputs": ["note.txt"] },
                "test": { "kind": "check", "workspace": folder, "run": "echo checked {{topic}}" },
                "approve": { "kind": "checkpoint", "ask": "Is the note about {{topic}} good?", "workspace": folder, "show": ["note.txt"], "sendBack": ["write"] }
            },
            "edges": [
                { "from": "write", "to": "test", "when": "done" },
                { "from": "test", "to": "approve", "when": "passed" }
            ]
        }))
    }

    #[tokio::test]
    async fn a_run_goes_through_its_graph_keeps_evidence_and_waits_for_the_user() {
        let fixture = setup();
        let runs = &fixture.runs;
        std::fs::write(Path::new(&fixture.folder).join("note.txt"), "a note").unwrap();
        runs.save_graph(three_steps(&fixture.folder)).unwrap();
        assert!(runs.start("three", None, Map::new(), json!({ "by": "user" }), Vec::new()).is_err(), "topic is required");
        let run = runs.start("three", None, params(json!({ "topic": "tea" })), json!({ "by": "user" }), Vec::new()).unwrap();
        let run_id = run["runId"].as_str().unwrap().to_string();
        let waiting = until_state(runs, &run_id, "waiting").await;
        assert_eq!(waiting["current"], "approve");
        assert_eq!(waiting["waitingOn"], "user");
        let attempts = waiting["attempts"].as_array().unwrap();
        assert_eq!(attempts[0]["result"], "done", "{waiting}");
        assert!(attempts[0]["evidence"]["taskId"].is_string());
        assert_eq!(attempts[0]["evidence"]["missing"], json!([]));
        assert_eq!(attempts[1]["result"], "passed");
        assert_eq!(attempts[1]["evidence"]["exitCode"], 0);
        let stdout = std::fs::read_to_string(attempts[1]["evidence"]["stdout"].as_str().unwrap()).unwrap();
        assert!(stdout.contains("checked tea"), "{stdout}");
        // The user's to-do: the question, what to look at, where it can go back.
        let todos = runs.todos()["todos"].clone();
        assert_eq!(todos[0]["ask"], "Is the note about tea good?");
        assert!(todos[0]["show"][0]["path"].as_str().unwrap().ends_with("note.txt"));
        assert_eq!(todos[0]["sendBack"], json!(["write"]));
        assert!(fixture.reports.lock().unwrap().iter().any(|report| report.contains("waits for you at approve")));
        // Sent back with a note: the step runs again, then comes back here.
        let refused = runs.decide(&run_id, Decision { decision: "sendBack".into(), node: Some("test".into()), note: None });
        assert!(refused.is_err(), "approve can only send back to write");
        runs.decide(&run_id, Decision { decision: "sendBack".into(), node: Some("write".into()), note: Some("shorter".into()) }).unwrap();
        let again = until_state(runs, &run_id, "waiting").await;
        let attempts = again["attempts"].as_array().unwrap();
        assert_eq!(attempts.len(), 6, "{again}");
        assert_eq!(attempts[2]["result"], "sentBack");
        assert_eq!(attempts[2]["evidence"]["decided"]["note"], "shorter");
        assert_eq!(attempts[3]["node"], "write");
        assert_eq!(attempts[3]["n"], 2);
        assert_eq!(attempts[3]["note"], "shorter");
        // A restart keeps the run where it is.
        let restarted = Runs::new(fixture.home.path(), runs.sessions.clone(), runs.tasks.clone());
        assert_eq!(restarted.todos()["todos"].as_array().map(Vec::len), Some(1));
        runs.decide(&run_id, Decision { decision: "approve".into(), node: None, note: None }).unwrap();
        let done = until_state(runs, &run_id, "finished").await;
        assert!(done["endedAt"].is_string());
        assert_eq!(runs.todos()["todos"], json!([]));
        assert!(runs.decide(&run_id, Decision { decision: "approve".into(), node: None, note: None }).is_err());
    }

    #[tokio::test]
    async fn a_graph_leaves_its_loop_by_its_own_edges() {
        let fixture = setup();
        let runs = &fixture.runs;
        let folder = &fixture.folder;
        runs.save_graph(graph(json!({
            "id": "loop", "start": "test",
            "nodes": {
                "test": { "kind": "check", "workspace": folder, "run": "exit 3" },
                "fix": { "kind": "agent", "workspace": folder, "brief": "Fix it" },
                "ask": { "kind": "checkpoint", "ask": "Tests keep failing. What now?", "sendBack": ["fix"] }
            },
            "edges": [
                { "from": "test", "to": "ask", "when": "failed", "attempts": 2 },
                { "from": "test", "to": "fix", "when": "failed" },
                { "from": "fix", "to": "test", "when": "done" }
            ]
        })))
        .unwrap();
        let run = runs.start("loop", None, Map::new(), json!({ "by": "user" }), Vec::new()).unwrap();
        let run_id = run["runId"].as_str().unwrap().to_string();
        let waiting = until_state(runs, &run_id, "waiting").await;
        let nodes: Vec<&str> = waiting["attempts"].as_array().unwrap().iter().map(|attempt| attempt["node"].as_str().unwrap()).collect();
        assert_eq!(nodes, ["test", "fix", "test", "ask"], "{waiting}");
        assert_eq!(waiting["attempts"][0]["evidence"]["exitCode"], 3);
        runs.decide(&run_id, Decision { decision: "stop".into(), node: None, note: None }).unwrap();
        let stopped = until_state(runs, &run_id, "stopped").await;
        assert!(stopped["reason"].as_str().unwrap().contains("ask"), "{stopped}");
    }

    #[tokio::test]
    async fn undelivered_work_and_a_missing_step_fail_the_run_with_the_reason() {
        let fixture = setup();
        let runs = &fixture.runs;
        runs.save_graph(graph(json!({
            "id": "deliver", "start": "write",
            "nodes": { "write": { "kind": "agent", "workspace": fixture.folder, "brief": "Write", "outputs": ["report.md"] } }
        })))
        .unwrap();
        let run = runs.start("deliver", None, Map::new(), json!({ "by": "user" }), Vec::new()).unwrap();
        let failed = until_state(runs, run["runId"].as_str().unwrap(), "failed").await;
        assert_eq!(failed["attempts"][0]["result"], "undelivered");
        assert_eq!(failed["attempts"][0]["evidence"]["missing"], json!(["report.md"]));
        assert!(failed["reason"].as_str().unwrap().contains("undelivered"), "{failed}");
        let reports = fixture.reports.lock().unwrap().join("\n");
        assert!(reports.contains("write ended undelivered"), "{reports}");
    }

    #[tokio::test]
    async fn the_user_stops_a_run_and_its_command_with_it() {
        let fixture = setup();
        let runs = &fixture.runs;
        runs.save_graph(graph(json!({
            "id": "slow", "start": "wait",
            "nodes": { "wait": { "kind": "check", "workspace": fixture.folder, "run": sleep_command() } }
        })))
        .unwrap();
        let mut ended = runs.subscribe_ended();
        let run = runs.start("slow", None, Map::new(), json!({ "by": "user" }), Vec::new()).unwrap();
        let run_id = run["runId"].as_str().unwrap().to_string();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(runs.get(&run_id).unwrap()["waitingOn"], "check");
        runs.stop(&run_id).unwrap();
        assert_eq!(runs.get(&run_id).unwrap()["state"], "stopped");
        assert!(runs.checks.lock().unwrap().is_empty());
        let event = ended.recv().await.unwrap();
        assert_eq!(event.kind, "run.ended");
        assert_eq!(event.fields["state"], "stopped");
        assert!(runs.stop(&run_id).is_err(), "already ended");
    }

    #[tokio::test]
    async fn shipped_graphs_are_valid_installed_and_never_replace_the_users_changes() {
        let fixture = setup();
        let runs = &fixture.runs;
        for text in SHIPPED {
            let graph: Graph = serde_json::from_str(text).unwrap();
            graph.check().unwrap();
            assert_eq!(runs.graph(&graph.id, None).unwrap().version, 1, "{} installed", graph.id);
        }
        // The user changes one; a restart (or a newer Desktop) leaves it alone.
        let mut mine = runs.graph("issue-loop", None).unwrap();
        mine.name = "Mine".into();
        runs.save_graph(mine).unwrap();
        std::fs::remove_file(fixture.home.path().join("graphs/issue-loop/shipped.json")).unwrap();
        std::fs::write(
            fixture.home.path().join("graphs/issue-loop/shipped.json"),
            serde_json::to_vec(&Graph { name: "Older shipped".into(), ..serde_json::from_str::<Graph>(SHIPPED[0]).unwrap() }).unwrap(),
        )
        .unwrap();
        let again = Runs::new(fixture.home.path(), runs.sessions.clone(), runs.tasks.clone());
        assert_eq!(again.graph("issue-loop", None).unwrap().name, "Mine");
        assert_eq!(again.graph("qa-release-loop", None).unwrap().version, 1);
    }

    #[tokio::test]
    async fn graphs_keep_their_versions_and_proposals_wait_for_the_user() {
        let fixture = setup();
        let runs = &fixture.runs;
        let bad = |value: Value| graph(value).check().is_err();
        assert!(bad(json!({ "id": "a b", "start": "x", "nodes": { "x": { "kind": "check", "workspace": ".", "run": "x" } } })));
        assert!(bad(json!({ "id": "g", "start": "y", "nodes": { "x": { "kind": "check", "workspace": ".", "run": "x" } } })));
        assert!(bad(json!({ "id": "g", "start": "x", "nodes": { "x": { "kind": "check", "workspace": ".", "run": "x" } }, "edges": [{ "from": "x", "to": "x", "when": "done" }] })));
        assert!(bad(json!({ "id": "g", "start": "x", "nodes": { "x": { "kind": "checkpoint", "ask": "?", "sendBack": ["nope"] } } })));
        assert!(bad(json!({ "id": "g", "start": "x", "params": { "n": "date" }, "nodes": { "x": { "kind": "checkpoint", "ask": "?" } } })));
        let first = runs.save_graph(three_steps(&fixture.folder)).unwrap();
        assert_eq!(first.version, 1);
        let mut changed = three_steps(&fixture.folder);
        changed.name = "Changed".into();
        assert_eq!(runs.save_graph(changed.clone()).unwrap().version, 2);
        assert_eq!(runs.graph("three", Some(1)).unwrap().name, "Write, test, approve");
        changed.name = "Proposed".into();
        runs.propose_graph(changed).unwrap();
        assert_eq!(runs.graph("three", None).unwrap().version, 2, "a proposal is not used");
        let three = || runs.list_graphs()["graphs"].as_array().unwrap().iter().find(|graph| graph["id"] == "three").cloned().unwrap();
        assert_eq!(three()["proposed"], true);
        let accepted = runs.accept_proposal("three").unwrap();
        assert_eq!((accepted.version, accepted.name.as_str()), (3, "Proposed"));
        assert!(runs.proposal("three").is_err());
        assert_eq!(three()["versions"], json!([1, 2, 3]));
    }
}
