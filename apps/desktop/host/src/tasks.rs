//! Tasks: work another agent (or the Assistant) hands to Desktop.
//!
//! A task is an ordinary session. The host keeps only what links the task to
//! that session (ids, folder, who asked); the task's state is always read from
//! the session itself and never stored. Operations return at once: a client
//! learns about progress from its inbox, which keeps one entry per task (the
//! latest), so a hundred tasks finishing together are one short read, not a
//! hundred wakes.
//!
//! Each running task holds one runtime process (#93). Above the cap a task
//! waits to start; it is not refused and nothing is retried.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Notify};

use crate::{
    policy::{self, Action},
    session::{ApiError, Session, SessionEvent, SessionManager},
    session_runs::Outcome,
};

/// Running tasks allowed at once unless the host is told otherwise.
pub const DEFAULT_CAP: usize = 4;
/// Longest a client may wait on its inbox in one call.
pub const MAX_WAIT: Duration = Duration::from_secs(60);

/// What the host keeps about a task. No state: that lives in the session.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_path: Option<String>,
    pub workspace: String,
    pub client_id: String,
    pub created_at: String,
    /// The request, only while the task waits for a free slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_text: Option<String>,
    /// The model the client asked for ({provider, id}); the session's own
    /// model is whatever its runtime reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    /// Why the task never got a session ("failed" to start, or "stopped"
    /// while it waited). A task with a session reads its state there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_started: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub seq: u64,
    pub task_id: String,
    pub state: String,
    pub at: String,
    /// The person wrote in the task's session themselves since the client
    /// last acknowledged it. Kept until then, whatever the state does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub user_wrote: bool,
}

/// Messages a task's client sends carry this id prefix; any other message in
/// the session came from the person.
const TASK_MESSAGE: &str = "task-msg-";

#[derive(Default, Serialize, Deserialize)]
struct Inbox {
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    entries: Vec<InboxEntry>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    tasks: Vec<TaskRecord>,
    #[serde(default)]
    inboxes: HashMap<String, Inbox>,
}

/// What the host knows right now about a running task's session. Memory only.
#[derive(Default, Clone)]
struct Live {
    state: Option<String>,
    /// A turn ran since the last message was sent: idle now means its run ended.
    ran: bool,
    watching: bool,
}

pub struct TaskManager {
    sessions: Arc<SessionManager>,
    file: PathBuf,
    store: Mutex<Store>,
    live: Mutex<HashMap<String, Live>>,
    notify: Notify,
    cap: usize,
}

/// States a task counts against the cap in: its runtime is in use.
fn active(state: &str) -> bool {
    matches!(state, "starting" | "running" | "waiting_user" | "held")
}

/// States a client is told about. Running is not news.
fn reportable(state: &str) -> bool {
    matches!(state, "waiting_user" | "held" | "finished" | "failed" | "stopped")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_id(prefix: &str) -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}{hex}")
}

/// The task's state once its session's latest run ended, from the session's
/// run record (`session_runs`), the one place that says how a run went.
fn ended_state(outcome: Option<Outcome>) -> &'static str {
    match outcome {
        Some(Outcome::Done) => "finished",
        Some(Outcome::Failed) => "failed",
        Some(Outcome::Stopped | Outcome::CutOff) => "stopped",
        None => "unloaded",
    }
}

/// Like `derive_state`, with how the run ended taken from its record.
fn task_state(summary: &Value, live: &Live, last_run: Result<Option<Outcome>, ()>) -> &'static str {
    match derive_state(summary, live.ran) {
        "finished" => match last_run {
            // The session is at rest but the record has not heard the end yet.
            Err(()) => "running",
            Ok(None) => "finished",
            Ok(outcome) => ended_state(outcome),
        },
        state => state,
    }
}

/// The task's state from its session's summary, as the user would see it.
pub fn derive_state(summary: &Value, ran: bool) -> &'static str {
    let waiting_user = summary["pendingApprovals"].as_array().is_some_and(|items| !items.is_empty())
        || summary["pendingQuestions"].as_array().is_some_and(|items| !items.is_empty());
    let status = summary["status"].as_str().unwrap_or("");
    if waiting_user || matches!(status, "waiting_approval" | "waiting_question") {
        return "waiting_user";
    }
    match status {
        "pending" | "starting" | "recovering" => "starting",
        "running" => "running",
        "error" => "failed",
        "stopped" | "cancelled" => "stopped",
        _ => {
            let queue: Vec<&str> = summary["queue"]
                .as_array()
                .map(|items| items.iter().filter_map(|item| item["state"].as_str()).collect())
                .unwrap_or_default();
            if queue.contains(&"held") {
                "held"
            } else if queue.contains(&"returned") {
                "stopped"
            } else if queue.iter().any(|state| matches!(*state, "queued" | "delivering")) {
                "running"
            } else if !summary["failedTurn"].is_null() {
                "failed"
            } else if ran {
                "finished"
            } else {
                "starting"
            }
        }
    }
}

impl TaskManager {
    pub fn new(sessions: Arc<SessionManager>, cap: usize) -> Arc<Self> {
        let file = sessions.home().join("tasks.json");
        let store = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Store>(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            sessions,
            file,
            store: Mutex::new(store),
            live: Mutex::new(HashMap::new()),
            notify: Notify::new(),
            cap: cap.max(1),
        })
    }

    fn home(&self) -> &Path {
        self.sessions.home()
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, store: &Store) {
        let Ok(bytes) = serde_json::to_vec_pretty(store) else { return };
        let temp = self.file.with_extension("json.tmp");
        if std::fs::write(&temp, bytes).is_ok() && std::fs::rename(&temp, &self.file).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }

    /// Tells every window that a task changed: the event names the task and
    /// its state; a window reads the rest (the session list, the task) itself.
    fn changed(&self, task_id: &str) {
        let Ok(record) = self.record(task_id) else { return };
        let state = self.state_of(&record);
        self.sessions.publish_control(
            "task.changed",
            json!({
                "taskId": record.task_id,
                "clientId": record.client_id,
                "sessionId": record.session_id,
                "sessionPath": record.session_path,
                "state": state,
            }),
        );
    }

    /// Marks each session a task runs in with `task: {taskId, clientId}`, so a
    /// list shows who started it. Matched by live id, else by saved file.
    pub fn mark_sessions(&self, sessions: &mut [Value]) {
        let store = self.store();
        if store.tasks.is_empty() {
            return;
        }
        let key = |path: &str| path.replace('\\', "/").to_lowercase();
        for session in sessions.iter_mut() {
            let id = session["sessionId"].as_str().map(str::to_string);
            let path = session["sessionPath"].as_str().map(key);
            let owner = store.tasks.iter().rev().find(|task| {
                (id.is_some() && task.session_id == id)
                    || (path.is_some() && task.session_path.as_deref().map(key) == path)
            });
            if let Some(task) = owner {
                session["task"] = json!({ "taskId": task.task_id, "clientId": task.client_id });
            }
        }
    }

    fn record(&self, task_id: &str) -> Result<TaskRecord, ApiError> {
        self.store()
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(axum::http::StatusCode::NOT_FOUND, "task-not-found", "No such task", false)
            })
    }

    /// The record must belong to `client`: one agent never sees another's tasks.
    fn owned(&self, client: &str, task_id: &str) -> Result<TaskRecord, ApiError> {
        let record = self.record(task_id)?;
        if record.client_id != client {
            return Err(ApiError::new(axum::http::StatusCode::NOT_FOUND, "task-not-found", "No such task", false));
        }
        Ok(record)
    }

    /// The folder must be one the user added. A task never opens a new folder.
    fn allowed_workspace(&self, workspace: &str) -> Result<String, ApiError> {
        let candidate = Path::new(workspace)
            .canonicalize()
            .map_err(|_| ApiError::bad_request("workspace is unavailable"))?;
        let allowed = self
            .sessions
            .workspaces()
            .into_iter()
            .filter_map(|value| value.get("path").and_then(Value::as_str).map(PathBuf::from))
            .filter_map(|path| path.canonicalize().ok())
            .any(|root| candidate.starts_with(root));
        if !allowed {
            return Err(ApiError::new(
                axum::http::StatusCode::FORBIDDEN,
                "workspace-not-allowed",
                "Tasks can only run in a folder the user added to Desktop",
                false,
            ));
        }
        // Without Windows' verbatim `\\?\` prefix, spelled like the folder list.
        Ok(crate::session::canonical_path(&candidate.to_string_lossy()))
    }

    fn check_text(text: &str) -> Result<(), ApiError> {
        if text.trim().is_empty() {
            return Err(ApiError::bad_request("text is required"));
        }
        // Slash commands are the user's controls (Flow, TextGuard, settings).
        if text.trim_start().starts_with('/') {
            return Err(ApiError::new(
                axum::http::StatusCode::FORBIDDEN,
                "command-not-allowed",
                "Tasks cannot run slash commands",
                false,
            ));
        }
        Ok(())
    }

    /// Starts a task and returns at once. Above the cap it waits to start.
    pub fn start(self: &Arc<Self>, client: &str, workspace: &str, text: &str) -> Result<Value, ApiError> {
        self.start_with(client, workspace, text, None)
    }

    /// Like `start`, on a model of the client's choosing (`{provider, id}`).
    pub fn start_with(
        self: &Arc<Self>,
        client: &str,
        workspace: &str,
        text: &str,
        model: Option<Value>,
    ) -> Result<Value, ApiError> {
        Self::check_text(text)?;
        if let Some(model) = &model {
            if !(model["provider"].is_string() && model["id"].is_string()) {
                return Err(ApiError::bad_request("model is {provider, id}"));
            }
        }
        let workspace = self.allowed_workspace(workspace)?;
        policy::authorize(self.home(), client, Some(&workspace), Action::StartTask)?;
        let task_id = new_id("task-");
        let record = TaskRecord {
            task_id: task_id.clone(),
            session_id: None,
            session_path: None,
            workspace: workspace.clone(),
            client_id: client.to_string(),
            created_at: now(),
            pending_text: Some(text.to_string()),
            model,
            not_started: None,
        };
        {
            let mut store = self.store();
            store.tasks.push(record);
            self.save(&store);
        }
        let launched = if self.running() < self.cap {
            self.launch(&task_id)
        } else {
            Ok(())
        };
        if let Err(error) = launched {
            let mut store = self.store();
            store.tasks.retain(|task| task.task_id != task_id);
            self.save(&store);
            return Err(error);
        }
        self.changed(&task_id);
        self.view(&self.record(&task_id)?)
    }

    fn running(&self) -> usize {
        self.live()
            .values()
            .filter(|live| live.state.as_deref().is_some_and(active))
            .count()
    }

    /// Opens the task's session and hands it the waiting request.
    fn launch(self: &Arc<Self>, task_id: &str) -> Result<(), ApiError> {
        let record = self.record(task_id)?;
        let Some(text) = record.pending_text.clone() else {
            return Ok(());
        };
        let session = self.sessions.create_pending(&record.workspace, None, None)?;
        if let Some(model) = &record.model {
            if let (Some(provider), Some(id)) = (model["provider"].as_str(), model["id"].as_str()) {
                session.request_model(provider, id);
            }
        }
        session.attach_early();
        let events = session.subscribe();
        self.live().insert(
            task_id.to_string(),
            Live { state: Some("starting".into()), ..Live::default() },
        );
        if let Err(error) = session.send_with_client(&new_id(TASK_MESSAGE), &text, Some(&record.client_id), &[]) {
            self.live().remove(task_id);
            session.stop();
            return Err(error);
        }
        {
            let mut store = self.store();
            if let Some(task) = store.tasks.iter_mut().find(|task| task.task_id == task_id) {
                task.session_id = Some(session.id.clone());
                task.pending_text = None;
            }
            self.save(&store);
        }
        self.watch(task_id, session, events);
        Ok(())
    }

    /// The task's session, opening its saved file again when it was let go.
    fn session(&self, record: &TaskRecord) -> Result<Arc<Session>, ApiError> {
        if let Some(session) = record.session_id.as_deref().and_then(|id| self.sessions.get(id)) {
            return Ok(session);
        }
        let Some(path) = record.session_path.clone() else {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "task-not-started",
                "The task has not started yet",
                true,
            ));
        };
        let session = self.sessions.create(&record.workspace, Some(path), None)?;
        let mut store = self.store();
        if let Some(task) = store.tasks.iter_mut().find(|task| task.task_id == record.task_id) {
            task.session_id = Some(session.id.clone());
        }
        self.save(&store);
        Ok(session)
    }

    /// Follows a task's session and tells the client when its state changes.
    fn watch(self: &Arc<Self>, task_id: &str, session: Arc<Session>, mut events: broadcast::Receiver<SessionEvent>) {
        {
            let mut live = self.live();
            let entry = live.entry(task_id.to_string()).or_default();
            if entry.watching {
                return;
            }
            entry.watching = true;
        }
        let manager = Arc::clone(self);
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            loop {
                let open = tokio::select! {
                    event = events.recv() => match event {
                        Ok(event) => {
                            if event.event == "turn.start" {
                                if let Some(live) = manager.live().get_mut(&task_id) {
                                    live.ran = true;
                                }
                            }
                            if event.event == "message.accepted"
                                && event.data["clientMessageId"].as_str().is_some_and(|id| !id.starts_with(TASK_MESSAGE))
                            {
                                manager.user_wrote(&task_id);
                            }
                            true
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => true,
                        Err(broadcast::error::RecvError::Closed) => false,
                    },
                    _ = tokio::time::sleep(Duration::from_secs(2)) => true,
                };
                if !open || !manager.refresh(&task_id, &session) {
                    break;
                }
            }
            if let Some(live) = manager.live().get_mut(&task_id) {
                live.watching = false;
                // Let go of (reaped, or the host is done with it): no runtime in use.
                if live.state.as_deref().is_some_and(active) {
                    live.state = None;
                }
            }
            manager.fill_slots();
        });
    }

    /// Reads the session again. False once the host let the session go.
    fn refresh(self: &Arc<Self>, task_id: &str, session: &Arc<Session>) -> bool {
        if self.sessions.get(&session.id).is_none() {
            return false;
        }
        if let Some(path) = session.saved_path() {
            let mut store = self.store();
            if let Some(task) = store.tasks.iter_mut().find(|task| task.task_id == task_id) {
                if task.session_path.as_deref() != Some(path.as_str()) {
                    task.session_path = Some(path);
                    self.save(&store);
                    drop(store);
                    self.changed(task_id);
                }
            }
        }
        let summary = session.summary();
        let last_run = self.last_run(session.saved_path().as_deref());
        let changed = {
            let mut live = self.live();
            let entry = live.entry(task_id.to_string()).or_default();
            if !summary["activeTurn"].is_null() {
                entry.ran = true;
            }
            let state = task_state(&summary, entry, last_run).to_string();
            if entry.state.as_deref() == Some(state.as_str()) {
                None
            } else {
                entry.state = Some(state.clone());
                Some(state)
            }
        };
        if let Some(state) = changed {
            self.changed(task_id);
            if reportable(&state) {
                self.report(task_id, &state);
            }
            if !active(&state) {
                self.fill_slots();
            }
        }
        true
    }

    /// The person wrote in the task's session: the client hears of it, with
    /// the task's state as it stands.
    fn user_wrote(&self, task_id: &str) {
        let Ok(record) = self.record(task_id) else { return };
        let state = self.state_of(&record);
        self.post(task_id, &state, true);
        self.changed(task_id);
    }

    /// One inbox entry per task: a newer state replaces the one not yet read.
    fn report(&self, task_id: &str, state: &str) {
        self.post(task_id, state, false);
    }

    fn post(&self, task_id: &str, state: &str, user_wrote: bool) {
        let Ok(record) = self.record(task_id) else { return };
        {
            let mut store = self.store();
            let inbox = store.inboxes.entry(record.client_id.clone()).or_default();
            inbox.seq += 1;
            let seq = inbox.seq;
            let wrote_before = inbox.entries.iter().any(|entry| entry.task_id == task_id && entry.user_wrote);
            inbox.entries.retain(|entry| entry.task_id != task_id);
            inbox.entries.push(InboxEntry {
                seq,
                task_id: task_id.to_string(),
                state: state.to_string(),
                at: now(),
                user_wrote: user_wrote || wrote_before,
            });
            self.save(&store);
            self.sessions.publish_control("inbox.changed", json!({ "clientId": record.client_id, "seq": seq }));
        }
        self.notify.notify_waiters();
    }

    /// Starts waiting tasks, oldest first, while slots are free.
    fn fill_slots(self: &Arc<Self>) {
        loop {
            if self.running() >= self.cap {
                return;
            }
            let next = self
                .store()
                .tasks
                .iter()
                .find(|task| task.pending_text.is_some() && task.session_id.is_none())
                .map(|task| task.task_id.clone());
            let Some(task_id) = next else { return };
            if let Err(error) = self.launch(&task_id) {
                crate::log(
                    self.home(),
                    "warn",
                    "task.start_failed",
                    json!({ "taskId": task_id, "code": error.code, "message": error.message }),
                );
                // Say so once, and leave it out of the queue: no retry.
                self.never_started(&task_id, "failed");
                self.report(&task_id, "failed");
                self.changed(&task_id);
            }
        }
    }

    /// The task leaves the queue without a session: `state` says why.
    fn never_started(&self, task_id: &str, state: &str) {
        let mut store = self.store();
        if let Some(task) = store.tasks.iter_mut().find(|task| task.task_id == task_id) {
            task.pending_text = None;
            task.not_started = Some(state.to_string());
        }
        self.save(&store);
    }

    /// How the latest run of the task's session went (`SessionManager::last_run`).
    fn last_run(&self, session_path: Option<&str>) -> Result<Option<Outcome>, ()> {
        match session_path {
            Some(path) => self.sessions.last_run(path),
            None => Ok(None),
        }
    }

    /// After start-up: a task whose run the host's exit cut off is reported
    /// stopped, once (the run record says so; `session_runs`). Then waiting
    /// tasks start. Called once.
    pub fn resume(self: &Arc<Self>) {
        let cut = self.sessions.cut_off_runs();
        let key = |path: &str| crate::session::canonical_path(path);
        let tasks: Vec<String> = self
            .store()
            .tasks
            .iter()
            .filter(|task| task.session_path.as_deref().is_some_and(|path| cut.contains(&key(path))))
            .map(|task| task.task_id.clone())
            .collect();
        for task_id in tasks {
            crate::log(self.home(), "info", "task.cut_by_exit", json!({ "taskId": task_id }));
            self.report(&task_id, "stopped");
            self.changed(&task_id);
        }
        self.fill_slots();
    }

    fn state_of(&self, record: &TaskRecord) -> String {
        if record.pending_text.is_some() && record.session_id.is_none() {
            return "waiting_to_start".into();
        }
        if let Some(state) = &record.not_started {
            return state.clone();
        }
        if let Some(session) = record.session_id.as_deref().and_then(|id| self.sessions.get(id)) {
            let live = self.live().get(&record.task_id).cloned().unwrap_or_default();
            let last_run = self.last_run(session.saved_path().as_deref());
            return task_state(&session.summary(), &live, last_run).to_string();
        }
        // Not open: as its latest run ended, or, with none recorded, unloaded
        // (the conversation is in its file).
        ended_state(self.last_run(record.session_path.as_deref()).ok().flatten()).into()
    }

    fn view(&self, record: &TaskRecord) -> Result<Value, ApiError> {
        let session = record.session_id.as_deref().and_then(|id| self.sessions.get(id));
        let title = session.as_ref().and_then(|session| session.summary()["title"].as_str().map(str::to_string));
        Ok(json!({
            "taskId": record.task_id,
            "sessionId": record.session_id,
            "sessionPath": record.session_path,
            "workspace": record.workspace,
            "createdAt": record.created_at,
            "state": self.state_of(record),
            "title": title,
        }))
    }

    pub fn get(&self, client: &str, task_id: &str) -> Result<Value, ApiError> {
        let record = self.owned(client, task_id)?;
        policy::authorize(self.home(), client, Some(&record.workspace), Action::ReadTask)?;
        self.view(&record)
    }

    pub fn list(&self, client: &str) -> Result<Value, ApiError> {
        policy::authorize(self.home(), client, None, Action::ListTasks)?;
        let records: Vec<TaskRecord> = self
            .store()
            .tasks
            .iter()
            .filter(|task| task.client_id == client)
            .cloned()
            .collect();
        let tasks: Vec<Value> = records.iter().filter_map(|record| self.view(record).ok()).collect();
        Ok(json!({ "tasks": tasks }))
    }

    /// Sends a follow-up message to a task. Returns at once.
    pub fn send(self: &Arc<Self>, client: &str, task_id: &str, text: &str) -> Result<Value, ApiError> {
        Self::check_text(text)?;
        let record = self.owned(client, task_id)?;
        policy::authorize(self.home(), client, Some(&record.workspace), Action::SendTask)?;
        let session = self.session(&record)?;
        let events = session.subscribe();
        if let Some(live) = self.live().get_mut(task_id) {
            live.ran = false;
        }
        session.send_with_client(&new_id(TASK_MESSAGE), text, Some(client), &[])?;
        self.live().entry(task_id.to_string()).or_default().ran = false;
        self.watch(task_id, session, events);
        self.view(&self.record(task_id)?)
    }

    /// Stops the task's current work. The conversation stays and can continue.
    pub fn stop(self: &Arc<Self>, client: &str, task_id: &str) -> Result<Value, ApiError> {
        let record = self.owned(client, task_id)?;
        policy::authorize(self.home(), client, Some(&record.workspace), Action::StopTask)?;
        if record.session_id.is_none() && record.pending_text.is_some() {
            self.never_started(task_id, "stopped");
            self.report(task_id, "stopped");
            self.changed(task_id);
            return self.view(&self.record(task_id)?);
        }
        if let Some(session) = record.session_id.as_deref().and_then(|id| self.sessions.get(id)) {
            session.interrupt()?;
        }
        self.view(&record)
    }

    /// The task's latest messages, oldest first, each in full. `limit` pages
    /// by message count, never by cutting text.
    pub fn read(&self, client: &str, task_id: &str, limit: usize) -> Result<Value, ApiError> {
        let record = self.owned(client, task_id)?;
        policy::authorize(self.home(), client, Some(&record.workspace), Action::ReadTask)?;
        let messages = self.conversation(record.session_id.as_deref(), record.session_path.as_deref(), limit)?;
        Ok(json!({
            "taskId": record.task_id,
            "state": self.state_of(&record),
            "messages": messages,
        }))
    }

    /// Any session's latest messages, each whole, read only: the live session
    /// when it is open, else its saved file. Only sessions the host lists.
    pub fn read_session(&self, session_path: &str, limit: usize) -> Result<Value, ApiError> {
        let key = |path: &str| path.replace('\\', "/").to_lowercase();
        let wanted = key(session_path);
        let mut listed = self.sessions.list();
        listed.extend(self.sessions.persisted(None, false));
        let found = listed
            .iter()
            .find(|session| session["sessionPath"].as_str().map(key).as_deref() == Some(wanted.as_str()))
            .ok_or_else(|| ApiError::bad_request("No such session; use a sessionPath from list_sessions"))?;
        let path = found["sessionPath"].as_str().map(str::to_string);
        let live = self
            .sessions
            .list()
            .into_iter()
            .find(|session| session["sessionPath"].as_str().map(key).as_deref() == Some(wanted.as_str()))
            .and_then(|session| session["sessionId"].as_str().map(str::to_string));
        let messages = self.conversation(live.as_deref(), path.as_deref(), limit)?;
        Ok(json!({ "sessionPath": path, "title": found["title"], "messages": messages }))
    }

    fn conversation(&self, session_id: Option<&str>, session_path: Option<&str>, limit: usize) -> Result<Vec<Value>, ApiError> {
        let limit = limit.clamp(1, 200);
        let live = session_id.and_then(|id| self.sessions.get(id));
        let messages: Vec<Value> = if let Some(session) = live {
            // Newest first; a streaming reply has cursor 0 and is the newest.
            let mut rows: Vec<Value> = session.history(limit, None)["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            rows.sort_by_key(|row| match row["cursor"].as_u64() {
                Some(0) | None => u64::MAX,
                Some(cursor) => cursor,
            });
            rows.iter().filter_map(live_row).collect()
        } else if let Some(path) = session_path {
            self.sessions.messages(path, Some(limit), None)?["messages"]
                .as_array()
                .map(|items| items.iter().filter_map(saved_message).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(messages)
    }

    pub fn inbox(&self, client: &str, after: u64) -> Result<Value, ApiError> {
        policy::authorize(self.home(), client, None, Action::ReadInbox)?;
        let store = self.store();
        let (entries, seq) = store
            .inboxes
            .get(client)
            .map(|inbox| {
                (
                    inbox.entries.iter().filter(|entry| entry.seq > after).cloned().collect::<Vec<_>>(),
                    inbox.seq,
                )
            })
            .unwrap_or_default();
        Ok(json!({ "entries": entries, "seq": seq }))
    }

    /// The host's own view of a client's inbox (for wake decisions); not a
    /// client operation, so no policy check and no log line.
    pub fn peek_inbox(&self, client: &str) -> Value {
        let store = self.store();
        let entries = store.inboxes.get(client).map(|inbox| inbox.entries.clone()).unwrap_or_default();
        json!({ "entries": entries })
    }

    /// Removes entries up to `seq`: the client has read them.
    pub fn ack(&self, client: &str, seq: u64) -> Result<Value, ApiError> {
        policy::authorize(self.home(), client, None, Action::ReadInbox)?;
        let mut store = self.store();
        let left = match store.inboxes.get_mut(client) {
            Some(inbox) => {
                inbox.entries.retain(|entry| entry.seq > seq);
                inbox.entries.len()
            }
            None => 0,
        };
        self.save(&store);
        let seq = store.inboxes.get(client).map(|inbox| inbox.seq).unwrap_or(0);
        drop(store);
        self.sessions.publish_control("inbox.changed", json!({ "clientId": client, "seq": seq }));
        Ok(json!({ "left": left }))
    }

    /// Waits until the inbox has entries after `after`, or the time is up.
    pub async fn wait(&self, client: &str, after: u64, timeout: Duration) -> Result<Value, ApiError> {
        let deadline = tokio::time::Instant::now() + timeout.min(MAX_WAIT);
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let current = self.inbox(client, after)?;
            if current["entries"].as_array().is_some_and(|entries| !entries.is_empty()) {
                return Ok(current);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.inbox(client, after);
            }
        }
    }
}

/// A message's text, whole: what a task produced is the task's answer.
fn whole(text: &str) -> Value {
    json!(text)
}

/// A row of a loaded session's history, in the task read shape.
fn live_row(row: &Value) -> Option<Value> {
    match row["kind"].as_str()? {
        "user" | "assistant" => Some(json!({
            "role": row["kind"],
            "text": whole(row["text"].as_str().unwrap_or("")),
        })),
        "tool" => Some(json!({
            "role": "tool",
            "tool": row["tool"]["name"],
            "status": row["tool"]["status"],
        })),
        _ => None,
    }
}

/// A message of a saved session file, in the task read shape.
fn saved_message(message: &Value) -> Option<Value> {
    let role = message["role"].as_str()?;
    let text_of = |content: &Value| -> String {
        match content {
            Value::String(text) => text.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    };
    match role {
        "user" => Some(json!({ "role": "user", "text": whole(&text_of(&message["content"])) })),
        "assistant" => {
            let tools: Vec<Value> = message["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block["type"] == "toolCall")
                        .map(|block| block["name"].clone())
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({ "role": "assistant", "text": whole(&text_of(&message["content"])), "tools": tools }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_after_a_turn_is_finished_and_before_is_starting() {
        let summary = json!({ "status": "idle", "queue": [], "failedTurn": null, "pendingApprovals": [], "pendingQuestions": [] });
        assert_eq!(derive_state(&summary, true), "finished");
        assert_eq!(derive_state(&summary, false), "starting");
    }

    #[test]
    fn prompts_for_the_user_win_over_running() {
        let summary = json!({ "status": "running", "pendingApprovals": [{ "id": "a" }], "queue": [] });
        assert_eq!(derive_state(&summary, true), "waiting_user");
    }

    #[test]
    fn held_and_failed_come_from_the_session() {
        let held = json!({ "status": "idle", "queue": [{ "state": "held" }], "failedTurn": null });
        assert_eq!(derive_state(&held, true), "held");
        let failed = json!({ "status": "idle", "queue": [], "failedTurn": { "turnId": "t" } });
        assert_eq!(derive_state(&failed, true), "failed");
    }
}

#[cfg(test)]
mod flow_tests {
    use super::*;
    use crate::session::RuntimeSpec;

    fn setup(env: &[(&str, &str)]) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
        let mut spec = RuntimeSpec::node_script(&fixture);
        spec.env.extend(env.iter().map(|(key, value)| ((*key).to_string(), (*value).to_string())));
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = Arc::new(SessionManager::new(
            Some(spec),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            None,
        ));
        manager
            .add_workspaces(&[workspace.path().to_string_lossy().into_owned()])
            .unwrap();
        (manager, home, workspace)
    }

    fn folder(workspace: &tempfile::TempDir) -> String {
        workspace.path().to_string_lossy().into_owned()
    }

    async fn wait_for(tasks: &TaskManager, client: &str, task_id: &str, state: &str) -> Vec<InboxEntry> {
        let mut after = 0;
        let mut seen = Vec::new();
        for _ in 0..20 {
            let batch = tasks.wait(client, after, Duration::from_secs(5)).await.unwrap();
            let entries: Vec<InboxEntry> = serde_json::from_value(batch["entries"].clone()).unwrap();
            if let Some(last) = entries.last() {
                after = last.seq;
            }
            let done = entries.iter().any(|entry| entry.task_id == task_id && entry.state == state);
            seen.extend(entries);
            if done {
                return seen;
            }
        }
        panic!("{task_id} never reached {state}; inbox saw {seen:?}");
    }

    #[tokio::test]
    async fn windows_hear_of_tasks_and_see_which_session_is_one() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let hub = crate::events::EventHub::new();
        let mut heard = hub.subscribe();
        let manager = Arc::new(SessionManager::new(
            Some(RuntimeSpec::node_script(&fixture)),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            Some(hub.clone()),
        ));
        manager.add_workspaces(&[folder(&workspace)]).unwrap();
        let tasks = TaskManager::new(manager.clone(), DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "write a haiku").unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        wait_for(&tasks, "agent-a", &task_id, "finished").await;

        let mut states = Vec::new();
        let mut inbox = false;
        while let Ok(event) = heard.try_recv() {
            match event.event.as_str() {
                "task.changed" if event.data["taskId"] == task_id.as_str() => {
                    assert_eq!(event.data["clientId"], "agent-a");
                    states.push(event.data["state"].as_str().unwrap_or("").to_string());
                }
                "inbox.changed" if event.data["clientId"] == "agent-a" => inbox = true,
                _ => {}
            }
        }
        assert!(states.first().is_some_and(|state| state == "starting" || state == "running"), "{states:?}");
        assert!(states.iter().any(|state| state == "finished"), "{states:?}");
        assert!(inbox, "the client's inbox change was not announced");

        // The session list says the session is the task's, live and once saved.
        let mut live = manager.list();
        tasks.mark_sessions(&mut live);
        let marked: Vec<&Value> = live.iter().filter(|session| !session["task"].is_null()).collect();
        assert_eq!(marked.len(), 1, "{live:?}");
        assert_eq!(marked[0]["task"], json!({ "taskId": task_id, "clientId": "agent-a" }));
        let path = tasks.get("agent-a", &task_id).unwrap()["sessionPath"].as_str().unwrap().to_string();
        let mut saved = vec![json!({ "sessionId": null, "sessionPath": path.replace('/', "\\").to_uppercase() })];
        tasks.mark_sessions(&mut saved);
        assert_eq!(saved[0]["task"]["taskId"], task_id.as_str(), "a differently spelled path is the same file");
    }

    #[tokio::test]
    async fn the_client_hears_when_the_person_writes_in_its_task() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager.clone(), DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "write a haiku").unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        let seen = wait_for(&tasks, "agent-a", &task_id, "finished").await;
        assert!(seen.iter().all(|entry| !entry.user_wrote), "its own message is not the person's: {seen:?}");
        let seq = tasks.inbox("agent-a", 0).unwrap()["seq"].as_u64().unwrap();
        tasks.ack("agent-a", seq).unwrap();

        let session = manager.get(task["sessionId"].as_str().unwrap()).unwrap();
        session.send_with_client("ui-1", "also make it rhyme", Some("desktop"), &[]).unwrap();
        let mut wrote = None;
        for _ in 0..50 {
            let entries: Vec<InboxEntry> = serde_json::from_value(tasks.inbox("agent-a", seq).unwrap()["entries"].clone()).unwrap();
            if let Some(entry) = entries.into_iter().find(|entry| entry.task_id == task_id && entry.user_wrote) {
                wrote = Some(entry);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let wrote = wrote.expect("the person's message never reached the inbox");
        // The mark stays when the state moves on, until the client acknowledges it.
        let after = wait_for(&tasks, "agent-a", &task_id, "finished").await;
        assert!(after.iter().filter(|entry| entry.seq > wrote.seq).all(|entry| entry.user_wrote), "{after:?}");
    }

    async fn until_state(tasks: &TaskManager, client: &str, task_id: &str, state: &str) {
        for _ in 0..100 {
            if tasks.get(client, task_id).unwrap()["state"] == state {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{task_id} never got to {state}: {}", tasks.get(client, task_id).unwrap());
    }

    #[tokio::test]
    async fn a_task_stopped_mid_turn_is_stopped_not_finished() {
        let (manager, _home, workspace) = setup(&[("FAKE_RUNTIME_DELAY_MS", "4000")]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "a long job").unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        until_state(&tasks, "agent-a", &task_id, "running").await;
        tasks.stop("agent-a", &task_id).unwrap();
        let seen = wait_for(&tasks, "agent-a", &task_id, "stopped").await;
        assert!(seen.iter().all(|entry| entry.state != "finished"), "{seen:?}");
        assert_eq!(tasks.get("agent-a", &task_id).unwrap()["state"], "stopped");
    }

    #[tokio::test]
    async fn a_task_cut_off_by_the_host_going_away_is_reported_stopped() {
        let (manager, home, workspace) = setup(&[("FAKE_RUNTIME_DELAY_MS", "8000")]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "a long job").unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        until_state(&tasks, "agent-a", &task_id, "running").await;

        // The host starts again on the same home: that session is gone.
        let start_again = || {
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runtime.mjs");
            let again = Arc::new(SessionManager::new(
                Some(RuntimeSpec::node_script(&fixture)),
                home.path().to_path_buf(),
                home.path().join("data"),
                None,
                50,
                None,
            ));
            again.add_workspaces(&[folder(&workspace)]).unwrap();
            let restarted = TaskManager::new(again, DEFAULT_CAP);
            restarted.resume();
            restarted
        };
        let restarted = start_again();
        let entries: Vec<InboxEntry> = serde_json::from_value(restarted.inbox("agent-a", 0).unwrap()["entries"].clone()).unwrap();
        assert!(entries.iter().any(|entry| entry.task_id == task_id && entry.state == "stopped"), "{entries:?}");
        assert_eq!(restarted.get("agent-a", &task_id).unwrap()["state"], "stopped");
        // Said once: another start does not say it again.
        let seq = restarted.inbox("agent-a", 0).unwrap()["seq"].as_u64().unwrap();
        drop(restarted);
        let third = start_again();
        assert_eq!(third.inbox("agent-a", 0).unwrap()["seq"].as_u64().unwrap(), seq);
        assert_eq!(third.get("agent-a", &task_id).unwrap()["state"], "stopped");
    }

    #[tokio::test]
    async fn a_task_returns_at_once_and_its_end_reaches_the_inbox() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "write a haiku").unwrap();
        // It returned before the work ran: the end arrives later, in the inbox.
        assert_ne!(task["state"], "finished", "{task}");
        let task_id = task["taskId"].as_str().unwrap().to_string();
        assert!(task["sessionId"].is_string());

        wait_for(&tasks, "agent-a", &task_id, "finished").await;
        let read = tasks.read("agent-a", &task_id, 20).unwrap();

        let messages = read["messages"].as_array().unwrap();
        assert!(messages.iter().any(|message| message["role"] == "user" && message["text"] == "write a haiku"), "{read}");
        assert!(messages.iter().any(|message| message["role"] == "assistant"), "{read}");

        let seq = tasks.inbox("agent-a", 0).unwrap()["seq"].as_u64().unwrap();
        assert_eq!(tasks.ack("agent-a", seq).unwrap()["left"], 0);
        assert!(tasks.inbox("agent-a", 0).unwrap()["entries"].as_array().unwrap().is_empty());

        // A follow-up goes to the same conversation and finishes again.
        tasks.send("agent-a", &task_id, "and another").unwrap();
        wait_for(&tasks, "agent-a", &task_id, "finished").await;
    }

    #[tokio::test]
    async fn a_read_returns_whole_messages_however_long() {
        // The fake runtime echoes the text back one character per tick.
        let (manager, _home, workspace) = setup(&[("FAKE_RUNTIME_DELAY_MS", "0")]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let long = format!("{}END", "x".repeat(6_000));
        let task = tasks.start("agent-a", &folder(&workspace), &long).unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        wait_for(&tasks, "agent-a", &task_id, "finished").await;
        let read = tasks.read("agent-a", &task_id, 20).unwrap();
        let user = read["messages"].as_array().unwrap().iter().find(|message| message["role"] == "user").unwrap().clone();
        assert_eq!(user["text"].as_str().unwrap().len(), long.len());
    }

    #[tokio::test]
    async fn slash_commands_and_unknown_folders_are_refused() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let refused = tasks.start("agent-a", &folder(&workspace), "/flow clear").unwrap_err();
        assert_eq!(refused.code, "command-not-allowed");
        let elsewhere = tempfile::tempdir().unwrap();
        let refused = tasks.start("agent-a", &folder(&elsewhere), "hello").unwrap_err();
        assert_eq!(refused.code, "workspace-not-allowed");
        assert!(tasks.list("agent-a").unwrap()["tasks"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn one_client_never_sees_another_clients_task() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager, DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "hello").unwrap();
        let task_id = task["taskId"].as_str().unwrap();
        assert_eq!(tasks.get("agent-b", task_id).unwrap_err().code, "task-not-found");
        assert_eq!(tasks.read("agent-b", task_id, 5).unwrap_err().code, "task-not-found");
        assert!(tasks.list("agent-b").unwrap()["tasks"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn above_the_cap_a_task_waits_and_starts_when_a_slot_frees() {
        let (manager, _home, workspace) = setup(&[("FAKE_RUNTIME_DELAY_MS", "200")]);
        let tasks = TaskManager::new(manager, 1);
        let first = tasks.start("agent-a", &folder(&workspace), "first").unwrap();
        let second = tasks.start("agent-a", &folder(&workspace), "second").unwrap();
        assert_eq!(second["state"], "waiting_to_start");
        assert!(second["sessionId"].is_null());
        let second_id = second["taskId"].as_str().unwrap().to_string();
        let seen = wait_for(&tasks, "agent-a", &second_id, "finished").await;
        let first_id = first["taskId"].as_str().unwrap();
        // The first one finished before the second could start.
        assert!(seen.iter().any(|entry| entry.task_id == first_id && entry.state == "finished")
            || tasks.get("agent-a", first_id).unwrap()["state"] == "finished");
    }

    #[tokio::test]
    async fn many_tasks_ending_together_are_one_entry_each() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager, 8);
        let mut ids = Vec::new();
        for n in 0..6 {
            ids.push(tasks.start("agent-a", &folder(&workspace), &format!("job {n}")).unwrap()["taskId"].as_str().unwrap().to_string());
        }
        for id in &ids {
            wait_for(&tasks, "agent-a", id, "finished").await;
        }
        let inbox = tasks.inbox("agent-a", 0).unwrap();
        let entries = inbox["entries"].as_array().unwrap();
        assert_eq!(entries.len(), ids.len(), "{inbox}");
    }

    #[tokio::test]
    async fn tasks_and_the_inbox_survive_a_host_restart() {
        let (manager, _home, workspace) = setup(&[]);
        let tasks = TaskManager::new(manager.clone(), DEFAULT_CAP);
        let task = tasks.start("agent-a", &folder(&workspace), "remember me").unwrap();
        let task_id = task["taskId"].as_str().unwrap().to_string();
        wait_for(&tasks, "agent-a", &task_id, "finished").await;
        drop(tasks);
        let again = TaskManager::new(manager, DEFAULT_CAP);
        let listed = again.list("agent-a").unwrap();
        assert_eq!(listed["tasks"][0]["taskId"], task_id.as_str());
        assert!(again.inbox("agent-a", 0).unwrap()["entries"].as_array().unwrap().iter().any(|entry| entry["taskId"] == task_id.as_str()));
        let read = again.read("agent-a", &task_id, 10).unwrap();
        assert!(!read["messages"].as_array().unwrap().is_empty(), "{read}");
    }

    #[tokio::test]
    async fn stopping_a_waiting_task_takes_it_out_of_the_queue() {
        let (manager, _home, workspace) = setup(&[("FAKE_RUNTIME_DELAY_MS", "300")]);
        let tasks = TaskManager::new(manager, 1);
        tasks.start("agent-a", &folder(&workspace), "first").unwrap();
        let second = tasks.start("agent-a", &folder(&workspace), "second").unwrap();
        let second_id = second["taskId"].as_str().unwrap();
        let stopped = tasks.stop("agent-a", second_id).unwrap();
        assert_eq!(stopped["state"], "stopped");
        wait_for(&tasks, "agent-a", second_id, "stopped").await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(tasks.get("agent-a", second_id).unwrap()["sessionId"].is_null());
    }
}
