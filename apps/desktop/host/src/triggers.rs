//! Triggers: "when this happens, do that", kept by the host.
//!
//! A trigger has a source (a time, the user pressing Run, or an event such as
//! a task ending), a filter on the event's fields, and an action (wake the
//! Assistant with a note, or start a task). Every firing is recorded with the
//! event that caused it, and one event never fires the same trigger twice,
//! across restarts too.
//!
//! Triggers only see events. Where an event came from (a timer, a task, later
//! a connector polling or a webhook) does not change how it is matched.
//!
//! Who decides: the user creates, edits, pauses and deletes triggers. The
//! Assistant may propose one; a proposal does nothing until the user turns it
//! on, because a trigger can start work and spend money while nobody watches.
//! The Assistant's own reminders (wake me later) need no confirmation, and it
//! can cancel them.
//!
//! The host sets no numbers here: how often a trigger repeats is the trigger's
//! own data.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use axum::http::StatusCode;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;

use crate::{session::{ApiError, SessionManager}, tasks::TaskManager};

/// Who created a trigger.
pub const BY_USER: &str = "user";
pub const BY_ASSISTANT: &str = "assistant";
/// Tasks a trigger starts belong to the user, like tasks started in Desktop.
const TASK_CLIENT: &str = "desktop";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// Once at `at`, or every `everySeconds` from `at` (from creation when
    /// `at` is missing).
    #[serde(rename_all = "camelCase")]
    Time {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        every_seconds: Option<u64>,
    },
    /// Only when the user presses Run.
    Manual,
    /// An event of this kind, e.g. "task.ended".
    Event { event: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    /// Wakes the Assistant with a note. `{{field}}` takes the event's field.
    WakeAssistant { text: String },
    /// Starts a task in a folder the user added. `{{field}}` as above.
    #[serde(rename_all = "camelCase")]
    StartTask {
        workspace: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<Value>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerState {
    /// Proposed by the Assistant; nothing fires until the user turns it on.
    Proposed,
    Enabled,
    Paused,
    /// A one-time trigger that has fired.
    Done,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: String,
    pub name: String,
    pub source: Source,
    /// Field -> value the event must carry. A list means any of them; a
    /// string with `*` matches any text there.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub filter: Map<String, Value>,
    pub action: Action,
    pub state: TriggerState,
    pub created_by: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<String>,
    /// Time triggers: when it fires next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_at: Option<String>,
}

/// Something that happened. `id` is unique per occurrence: it is what keeps
/// one event from firing a trigger twice.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub kind: String,
    pub at: String,
    pub fields: Value,
}

/// One firing, as recorded.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Firing {
    pub at: String,
    pub trigger_id: String,
    pub event: Event,
    /// "started" or "failed".
    pub outcome: String,
    /// What the action did (the task id, the note) or why it failed.
    pub detail: Value,
}

/// Fields the user or the Assistant send to create or change a trigger.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInput {
    pub name: Option<String>,
    pub source: Option<Source>,
    pub filter: Option<Map<String, Value>>,
    pub action: Option<Action>,
    pub state: Option<TriggerState>,
}

type Waker = Box<dyn Fn(String) + Send + Sync>;

pub struct Triggers {
    dir: PathBuf,
    sessions: Arc<SessionManager>,
    tasks: Arc<TaskManager>,
    store: Mutex<Store>,
    changed: Notify,
    /// How a firing reaches the Assistant (set when the Assistant starts).
    waker: OnceLock<Waker>,
}

#[derive(Default)]
struct Store {
    triggers: Vec<Trigger>,
    /// (trigger id, event id) pairs that already fired.
    fired: HashSet<(String, String)>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse(time: &str) -> Result<DateTime<Utc>, ApiError> {
    DateTime::parse_from_rfc3339(time)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| ApiError::bad_request(format!("{time} is not an RFC 3339 time")))
}

fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("trigger-{hex}")
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "trigger-not-found", "No such trigger", false)
}

/// `*` in `pattern` matches any text; everything else must be equal.
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || !text[first.len()..].ends_with(last) || text.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

fn value_matches(wanted: &Value, got: &Value) -> bool {
    match (wanted, got) {
        (Value::Array(any), _) => any.iter().any(|wanted| value_matches(wanted, got)),
        (Value::String(pattern), Value::String(text)) => glob(pattern, text),
        _ => wanted == got,
    }
}

pub fn matches(filter: &Map<String, Value>, fields: &Value) -> bool {
    filter.iter().all(|(key, wanted)| value_matches(wanted, &fields[key.as_str()]))
}

/// The triggers that led to the event's work, oldest first.
fn chain(fields: &Value) -> Vec<String> {
    serde_json::from_value(fields["triggeredBy"].clone()).unwrap_or_default()
}

/// Puts the event's fields into `{{field}}`. A field the event does not
/// carry is an error: the action would run with words missing.
pub fn fill(template: &str, fields: &Value) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else { break };
        out.push_str(&rest[..start]);
        let name = rest[start + 2..start + end].trim();
        match &fields[name] {
            Value::String(text) => out.push_str(text),
            Value::Null => return Err(format!("the event has no field {name}")),
            other => out.push_str(&other.to_string()),
        }
        rest = &rest[start + end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

impl Triggers {
    pub fn new(home: &Path, sessions: Arc<SessionManager>, tasks: Arc<TaskManager>) -> Arc<Self> {
        let dir = home.join("triggers");
        let triggers = std::fs::read(dir.join("triggers.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Trigger>>(&bytes).ok())
            .unwrap_or_default();
        let fired = std::fs::read_to_string(dir.join("firings.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Firing>(line).ok())
            .map(|firing| (firing.trigger_id, firing.event.id))
            .collect();
        Arc::new(Self {
            dir,
            sessions,
            tasks,
            store: Mutex::new(Store { triggers, fired }),
            changed: Notify::new(),
            waker: OnceLock::new(),
        })
    }

    /// How a firing reaches the Assistant. Set once.
    pub fn set_waker(&self, waker: impl Fn(String) + Send + Sync + 'static) {
        let _ = self.waker.set(Box::new(waker));
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, store: &Store) {
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.dir.join("triggers.json");
        let temp = self.dir.join("triggers.json.tmp");
        if std::fs::write(&temp, serde_json::to_vec_pretty(&store.triggers).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }

    fn changed(&self, id: &str) {
        self.sessions.publish_control("triggers.changed", json!({ "id": id }));
        self.changed.notify_one();
    }

    /// Starts the clock and the listener for task events. Called once.
    pub fn launch(self: &Arc<Self>) {
        let triggers = Arc::clone(self);
        tokio::spawn(async move { triggers.clock().await });
        let triggers = Arc::clone(self);
        let mut ended = self.tasks.subscribe_ended();
        tokio::spawn(async move {
            while let Some(event) = ended.recv().await {
                triggers.emit(event).await;
            }
        });
    }

    pub fn list(&self) -> Value {
        json!({ "triggers": self.store().triggers })
    }

    pub fn get(&self, id: &str) -> Result<Trigger, ApiError> {
        self.store().triggers.iter().find(|trigger| trigger.id == id).cloned().ok_or_else(not_found)
    }

    /// The newest firings first, of one trigger or all.
    pub fn firings(&self, trigger: Option<&str>, limit: Option<usize>) -> Value {
        let mut rows: Vec<Firing> = std::fs::read_to_string(self.dir.join("firings.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Firing>(line).ok())
            .filter(|firing| trigger.is_none_or(|id| firing.trigger_id == id))
            .collect();
        rows.reverse();
        if let Some(limit) = limit {
            rows.truncate(limit);
        }
        json!({ "firings": rows })
    }

    fn check(source: &Source, action: &Action) -> Result<(), ApiError> {
        if let Source::Time { at, every_seconds } = source {
            if at.is_none() && every_seconds.is_none() {
                return Err(ApiError::bad_request("A time trigger needs at, everySeconds, or both"));
            }
            if let Some(at) = at {
                parse(at)?;
            }
            if *every_seconds == Some(0) {
                return Err(ApiError::bad_request("everySeconds must be at least 1"));
            }
        }
        if let Source::Event { event } = source {
            if event.trim().is_empty() {
                return Err(ApiError::bad_request("An event trigger names its event"));
            }
        }
        match action {
            Action::WakeAssistant { text } if text.trim().is_empty() => Err(ApiError::bad_request("The note is empty")),
            Action::StartTask { workspace, text, model } => {
                if workspace.trim().is_empty() || text.trim().is_empty() {
                    return Err(ApiError::bad_request("A task needs a folder and what to do"));
                }
                if let Some(model) = model {
                    if !(model["provider"].is_string() && model["id"].is_string()) {
                        return Err(ApiError::bad_request("model is {provider, id}"));
                    }
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// When a time trigger fires first.
    fn first_at(source: &Source) -> Option<String> {
        match source {
            Source::Time { at: Some(at), .. } => Some(at.clone()),
            Source::Time { at: None, every_seconds: Some(every) } => {
                Some(iso(Utc::now() + chrono::Duration::seconds(*every as i64)))
            }
            _ => None,
        }
    }

    /// Creates a trigger. The user's start on; the Assistant's start as a
    /// proposal, except its own reminders (see `remind`).
    pub fn create(&self, by: &str, input: TriggerInput) -> Result<Trigger, ApiError> {
        let source = input.source.ok_or_else(|| ApiError::bad_request("source is required"))?;
        let action = input.action.ok_or_else(|| ApiError::bad_request("action is required"))?;
        Self::check(&source, &action)?;
        let state = if by == BY_USER {
            match input.state {
                Some(TriggerState::Paused) => TriggerState::Paused,
                _ => TriggerState::Enabled,
            }
        } else {
            TriggerState::Proposed
        };
        let trigger = Trigger {
            id: new_id(),
            name: input.name.filter(|name| !name.trim().is_empty()).unwrap_or_else(|| "Trigger".into()),
            next_at: Self::first_at(&source),
            source,
            filter: input.filter.unwrap_or_default(),
            action,
            state,
            created_by: by.to_string(),
            created_at: now_iso(),
            last_fired_at: None,
        };
        let mut store = self.store();
        store.triggers.push(trigger.clone());
        self.save(&store);
        drop(store);
        self.changed(&trigger.id);
        Ok(trigger)
    }

    /// The Assistant's own reminder: wake it with `note` after `seconds`.
    /// On at once; the Assistant can cancel it.
    pub fn remind(&self, seconds: u64, note: &str) -> Result<Trigger, ApiError> {
        if seconds == 0 {
            return Err(ApiError::bad_request("seconds must be at least 1"));
        }
        let at = iso(Utc::now() + chrono::Duration::seconds(seconds as i64));
        let trigger = Trigger {
            id: new_id(),
            name: if note.trim().is_empty() { "Reminder".into() } else { note.to_string() },
            source: Source::Time { at: Some(at.clone()), every_seconds: None },
            filter: Map::new(),
            action: Action::WakeAssistant { text: if note.trim().is_empty() { "Reminder".into() } else { note.to_string() } },
            state: TriggerState::Enabled,
            created_by: BY_ASSISTANT.into(),
            created_at: now_iso(),
            last_fired_at: None,
            next_at: Some(at),
        };
        let mut store = self.store();
        store.triggers.push(trigger.clone());
        self.save(&store);
        drop(store);
        self.changed(&trigger.id);
        Ok(trigger)
    }

    /// The Assistant cancels one of its own reminders. Nothing else: the
    /// user's triggers and its accepted proposals are the user's.
    pub fn cancel_reminder(&self, id: &str) -> Result<(), ApiError> {
        let mut store = self.store();
        let trigger = store.triggers.iter().find(|trigger| trigger.id == id).ok_or_else(not_found)?;
        let reminder = trigger.created_by == BY_ASSISTANT
            && matches!(trigger.action, Action::WakeAssistant { .. })
            && matches!(trigger.source, Source::Time { .. })
            && trigger.state != TriggerState::Proposed;
        let proposal = trigger.created_by == BY_ASSISTANT && trigger.state == TriggerState::Proposed;
        if !(reminder || proposal) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "not-yours", "Only the user can change this trigger", false));
        }
        store.triggers.retain(|trigger| trigger.id != id);
        self.save(&store);
        drop(store);
        self.changed(id);
        Ok(())
    }

    /// The user changes a trigger: its fields, or its state (turning a
    /// proposal on is the user's confirmation).
    pub fn update(&self, id: &str, input: TriggerInput) -> Result<Trigger, ApiError> {
        let mut store = self.store();
        let trigger = store.triggers.iter_mut().find(|trigger| trigger.id == id).ok_or_else(not_found)?;
        let source = input.source.clone().unwrap_or_else(|| trigger.source.clone());
        let action = input.action.clone().unwrap_or_else(|| trigger.action.clone());
        Self::check(&source, &action)?;
        if input.state == Some(TriggerState::Proposed) {
            return Err(ApiError::bad_request("A trigger can be enabled or paused"));
        }
        let source_changed = source != trigger.source;
        if let Some(name) = input.name.filter(|name| !name.trim().is_empty()) {
            trigger.name = name;
        }
        if let Some(filter) = input.filter {
            trigger.filter = filter;
        }
        trigger.source = source;
        trigger.action = action;
        if let Some(state) = input.state {
            trigger.state = state;
        }
        if source_changed {
            trigger.next_at = Self::first_at(&trigger.source);
            if trigger.state == TriggerState::Done {
                trigger.state = TriggerState::Enabled;
            }
        }
        let trigger = trigger.clone();
        self.save(&store);
        drop(store);
        self.changed(id);
        Ok(trigger)
    }

    pub fn delete(&self, id: &str) -> Result<(), ApiError> {
        let mut store = self.store();
        let before = store.triggers.len();
        store.triggers.retain(|trigger| trigger.id != id);
        if store.triggers.len() == before {
            return Err(not_found());
        }
        self.save(&store);
        drop(store);
        self.changed(id);
        Ok(())
    }

    /// The user presses Run: fires once now, whatever the source, unless it
    /// is only a proposal.
    pub async fn run_now(&self, id: &str) -> Result<Firing, ApiError> {
        let trigger = self.get(id)?;
        if trigger.state == TriggerState::Proposed {
            return Err(ApiError::bad_request("Turn the proposal on first"));
        }
        let at = now_iso();
        let event = Event { id: format!("manual:{id}:{at}"), kind: "manual".into(), at, fields: json!({}) };
        self.fire(&trigger, event).await.ok_or_else(|| ApiError::internal("The run was not recorded"))
    }

    /// An event happened: every enabled trigger waiting for it fires, once.
    pub async fn emit(&self, event: Event) {
        let due: Vec<Trigger> = self
            .store()
            .triggers
            .iter()
            .filter(|trigger| trigger.state == TriggerState::Enabled)
            .filter(|trigger| matches!(&trigger.source, Source::Event { event: kind } if *kind == event.kind))
            .filter(|trigger| matches(&trigger.filter, &event.fields))
            // Never on the end of work this trigger led to: no loops.
            .filter(|trigger| !chain(&event.fields).contains(&trigger.id))
            .cloned()
            .collect();
        for trigger in due {
            self.fire(&trigger, event.clone()).await;
        }
    }

    /// Records the firing first (so one event fires a trigger once, even if
    /// the action is slow or the host stops), then acts.
    async fn fire(&self, trigger: &Trigger, event: Event) -> Option<Firing> {
        {
            let mut store = self.store();
            if !store.fired.insert((trigger.id.clone(), event.id.clone())) {
                return None;
            }
            if let Some(saved) = store.triggers.iter_mut().find(|saved| saved.id == trigger.id) {
                saved.last_fired_at = Some(now_iso());
            }
            self.save(&store);
        }
        let (outcome, detail) = match self.act(trigger, &event.fields) {
            Ok(detail) => ("started", detail),
            Err(message) => ("failed", json!({ "error": message })),
        };
        let firing = Firing {
            at: now_iso(),
            trigger_id: trigger.id.clone(),
            event,
            outcome: outcome.into(),
            detail,
        };
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("firings.jsonl")) {
            use std::io::Write;
            let _ = writeln!(file, "{}", serde_json::to_string(&firing).unwrap_or_default());
        }
        crate::log(
            self.sessions.home(),
            if outcome == "started" { "info" } else { "warn" },
            "trigger.fired",
            json!({ "trigger": trigger.id, "event": firing.event.id, "outcome": outcome }),
        );
        self.sessions.publish_control("triggers.fired", json!({ "triggerId": trigger.id, "outcome": outcome }));
        Some(firing)
    }

    fn act(&self, trigger: &Trigger, fields: &Value) -> Result<Value, String> {
        match &trigger.action {
            Action::WakeAssistant { text } => {
                let note = fill(text, fields)?;
                match self.waker.get() {
                    Some(wake) => {
                        wake(note.clone());
                        Ok(json!({ "note": note }))
                    }
                    None => Err("The Assistant is not available".into()),
                }
            }
            Action::StartTask { workspace, text, model } => {
                let text = fill(text, fields)?;
                let workspace = fill(workspace, fields)?;
                let mut led_by = chain(fields);
                led_by.push(trigger.id.clone());
                self.tasks
                    .start_triggered(TASK_CLIENT, &workspace, &text, model.clone(), led_by)
                    .map(|task| json!({ "taskId": task["taskId"] }))
                    .map_err(|error| error.message)
            }
        }
    }

    /// Fires time triggers when they are due, sleeping until the next one or
    /// a change. A trigger missed while the host was off fires once on start.
    async fn clock(self: Arc<Self>) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let now = Utc::now();
            let mut next: Option<DateTime<Utc>> = None;
            let mut due: Vec<(Trigger, DateTime<Utc>)> = Vec::new();
            for trigger in self.store().triggers.iter().filter(|trigger| trigger.state == TriggerState::Enabled) {
                let Some(at) = trigger.next_at.as_deref().and_then(|at| parse(at).ok()) else { continue };
                if !matches!(trigger.source, Source::Time { .. }) {
                    continue;
                }
                if at <= now {
                    due.push((trigger.clone(), at));
                } else if next.is_none_or(|next| at < next) {
                    next = Some(at);
                }
            }
            for (trigger, at) in due {
                self.advance(&trigger.id, at, now);
                let event = Event {
                    id: format!("time:{}:{}", trigger.id, iso(at)),
                    kind: "time".into(),
                    at: iso(at),
                    fields: json!({}),
                };
                self.fire(&trigger, event).await;
            }
            match next {
                Some(at) => {
                    let wait = (at - Utc::now()).to_std().unwrap_or_default();
                    tokio::select! {
                        _ = changed => {}
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
                None => changed.await,
            }
        }
    }

    /// Moves a time trigger past `fired_at`: the next repeat after now, or done.
    fn advance(&self, id: &str, fired_at: DateTime<Utc>, now: DateTime<Utc>) {
        let mut store = self.store();
        let Some(trigger) = store.triggers.iter_mut().find(|trigger| trigger.id == id) else { return };
        match trigger.source {
            Source::Time { every_seconds: Some(every), .. } => {
                let step = chrono::Duration::seconds(every as i64);
                let missed = ((now - fired_at).num_seconds() / every as i64) + 1;
                trigger.next_at = Some(iso(fired_at + step * missed as i32));
            }
            _ => {
                trigger.next_at = None;
                trigger.state = TriggerState::Done;
            }
        }
        self.save(&store);
        drop(store);
        self.sessions.publish_control("triggers.changed", json!({ "id": id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_match_values_lists_and_patterns() {
        let fields = json!({ "state": "failed", "workspace": "C:/work/app", "seq": 3 });
        let filter = |value: Value| value.as_object().cloned().unwrap();
        assert!(matches(&filter(json!({})), &fields));
        assert!(matches(&filter(json!({ "state": "failed" })), &fields));
        assert!(matches(&filter(json!({ "state": ["finished", "failed"] })), &fields));
        assert!(matches(&filter(json!({ "workspace": "C:/work/*" })), &fields));
        assert!(matches(&filter(json!({ "workspace": "*app" })), &fields));
        assert!(matches(&filter(json!({ "seq": 3 })), &fields));
        assert!(!matches(&filter(json!({ "state": "finished" })), &fields));
        assert!(!matches(&filter(json!({ "workspace": "D:/*" })), &fields));
        assert!(!matches(&filter(json!({ "missing": "x" })), &fields));
        assert!(glob("1.2.*-rc.*", "1.2.0-rc.3"));
        assert!(!glob("1.2.*-rc.*", "1.2.0"));
        assert!(glob("a*a", "aa"));
        assert!(!glob("a*a", "a"));
    }

    #[test]
    fn templates_take_the_event_fields_and_refuse_missing_ones() {
        let fields = json!({ "taskId": "task-1", "seq": 4 });
        assert_eq!(fill("Look at {{taskId}} ({{ seq }})", &fields).unwrap(), "Look at task-1 (4)");
        assert_eq!(fill("no fields", &fields).unwrap(), "no fields");
        assert!(fill("{{issue}}", &fields).unwrap_err().contains("issue"));
    }

    use crate::session::RuntimeSpec;

    fn setup() -> (Arc<Triggers>, Arc<TaskManager>, tempfile::TempDir, tempfile::TempDir) {
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
        sessions.add_workspaces(&[workspace.path().to_string_lossy().into_owned()]).unwrap();
        let tasks = TaskManager::new(sessions.clone());
        let triggers = Triggers::new(home.path(), sessions, tasks.clone());
        (triggers, tasks, home, workspace)
    }

    fn input(value: Value) -> TriggerInput {
        serde_json::from_value(value).unwrap()
    }

    fn fired(triggers: &Triggers, id: &str) -> Vec<Value> {
        triggers.firings(Some(id), None)["firings"].as_array().cloned().unwrap_or_default()
    }

    async fn until(mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("never happened");
    }

    #[tokio::test]
    async fn one_event_fires_a_trigger_once_and_is_recorded() {
        let (triggers, _tasks, _home, _workspace) = setup();
        let notes = Arc::new(Mutex::new(Vec::new()));
        let sink = notes.clone();
        triggers.set_waker(move |note| sink.lock().unwrap().push(note));
        let trigger = triggers
            .create(BY_USER, input(json!({ "name": "Failed tasks", "source": { "kind": "event", "event": "task.ended" }, "filter": { "state": "failed" }, "action": { "kind": "wakeAssistant", "text": "{{taskId}} failed" } })))
            .unwrap();
        let event = |id: &str, state: &str| Event { id: id.into(), kind: "task.ended".into(), at: now_iso(), fields: json!({ "taskId": "task-9", "state": state }) };
        triggers.emit(event("a", "failed")).await;
        triggers.emit(event("a", "failed")).await;
        triggers.emit(event("b", "finished")).await;
        triggers.emit(Event { kind: "other".into(), ..event("c", "failed") }).await;
        assert_eq!(*notes.lock().unwrap(), vec!["task-9 failed".to_string()]);
        let rows = fired(&triggers, &trigger.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["event"]["id"], "a");
        assert_eq!(rows[0]["outcome"], "started");
        // A restart remembers what fired.
        let again = Triggers::new(_home.path(), triggers.sessions.clone(), triggers.tasks.clone());
        again.set_waker(|_| panic!("fired twice"));
        again.emit(event("a", "failed")).await;
        assert_eq!(fired(&again, &trigger.id).len(), 1);
        // Paused: nothing fires.
        triggers.update(&trigger.id, TriggerInput { state: Some(TriggerState::Paused), ..Default::default() }).unwrap();
        triggers.emit(event("d", "failed")).await;
        assert_eq!(notes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_task_ending_can_start_another_task() {
        let (triggers, tasks, _home, workspace) = setup();
        triggers.launch();
        let folder = workspace.path().to_string_lossy().into_owned();
        let trigger = triggers
            .create(BY_USER, input(json!({ "name": "Review", "source": { "kind": "event", "event": "task.ended" }, "filter": { "state": "finished", "clientId": "agent-a" }, "action": { "kind": "startTask", "workspace": "{{workspace}}", "text": "Review what {{taskId}} did" } })))
            .unwrap();
        let first = tasks.start("agent-a", &folder, "write a haiku").unwrap();
        let first_id = first["taskId"].as_str().unwrap().to_string();
        until(|| fired(&triggers, &trigger.id).len() == 1).await;
        let row = fired(&triggers, &trigger.id).remove(0);
        assert_eq!(row["outcome"], "started", "{row}");
        assert_eq!(row["event"]["fields"]["taskId"], first_id.as_str());
        let started = row["detail"]["taskId"].as_str().unwrap();
        // The started task is the user's, and does not set the trigger off again.
        let listed = tasks.list("desktop").unwrap();
        assert!(listed.to_string().contains(started), "{listed}");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(fired(&triggers, &trigger.id).len(), 1);
    }

    #[tokio::test]
    async fn triggers_cannot_loop_through_the_tasks_they_start() {
        let (triggers, tasks, _home, workspace) = setup();
        triggers.launch();
        let folder = workspace.path().to_string_lossy().into_owned();
        // Both fire on any task ending: each would start the other forever.
        let make = |name: &str| {
            triggers
                .create(BY_USER, input(json!({ "name": name, "source": { "kind": "event", "event": "task.ended" }, "action": { "kind": "startTask", "workspace": folder, "text": name } })))
                .unwrap()
        };
        let (a, b) = (make("a"), make("b"));
        tasks.start("agent-a", &folder, "write a haiku").unwrap();
        // The first task starts one task each; their ends start one more each
        // (a after b, b after a); those ends start nothing.
        until(|| fired(&triggers, &a.id).len() == 2 && fired(&triggers, &b.id).len() == 2).await;
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert_eq!(fired(&triggers, &a.id).len(), 2);
        assert_eq!(fired(&triggers, &b.id).len(), 2);
    }

    #[tokio::test]
    async fn an_action_that_cannot_run_is_recorded_as_failed() {
        let (triggers, _tasks, _home, _workspace) = setup();
        let trigger = triggers
            .create(BY_USER, input(json!({ "source": { "kind": "manual" }, "action": { "kind": "startTask", "workspace": "/not/a/folder/of/the/user", "text": "x" } })))
            .unwrap();
        let firing = triggers.run_now(&trigger.id).await.unwrap();
        assert_eq!(firing.outcome, "failed");
        assert!(firing.detail["error"].is_string(), "{:?}", firing.detail);
        let missing = triggers
            .create(BY_USER, input(json!({ "source": { "kind": "manual" }, "action": { "kind": "wakeAssistant", "text": "{{issue}}" } })))
            .unwrap();
        let firing = triggers.run_now(&missing.id).await.unwrap();
        assert_eq!(firing.outcome, "failed");
    }

    #[tokio::test]
    async fn time_triggers_fire_when_due_and_once_after_a_restart() {
        let (triggers, _tasks, home, _workspace) = setup();
        let notes = Arc::new(Mutex::new(Vec::new()));
        let sink = notes.clone();
        triggers.set_waker(move |note| sink.lock().unwrap().push(note));
        let soon = iso(Utc::now() + chrono::Duration::milliseconds(300));
        let once = triggers
            .create(BY_USER, input(json!({ "source": { "kind": "time", "at": soon }, "action": { "kind": "wakeAssistant", "text": "once" } })))
            .unwrap();
        // Missed while the host was off: fires once, then the next repeat is ahead.
        let past = iso(Utc::now() - chrono::Duration::seconds(3600 * 5 + 10));
        let hourly = triggers
            .create(BY_USER, input(json!({ "source": { "kind": "time", "at": past, "everySeconds": 3600 }, "action": { "kind": "wakeAssistant", "text": "hourly" } })))
            .unwrap();
        triggers.launch();
        until(|| notes.lock().unwrap().len() == 2).await;
        assert_eq!(triggers.get(&once.id).unwrap().state, TriggerState::Done);
        let next = parse(triggers.get(&hourly.id).unwrap().next_at.as_deref().unwrap()).unwrap();
        assert!(next > Utc::now() && next <= Utc::now() + chrono::Duration::seconds(3600), "{next}");
        // A restart does not fire them again.
        let again = Triggers::new(home.path(), triggers.sessions.clone(), triggers.tasks.clone());
        again.set_waker(|note| panic!("fired again: {note}"));
        again.launch();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(notes.lock().unwrap().len(), 2);
    }

    #[test]
    fn bad_triggers_are_refused() {
        let (triggers, _tasks, _home, _workspace) = {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let _guard = runtime.enter();
            setup()
        };
        let refused = |value: Value| triggers.create(BY_USER, input(value)).is_err();
        assert!(refused(json!({ "source": { "kind": "time" }, "action": { "kind": "wakeAssistant", "text": "x" } })));
        assert!(refused(json!({ "source": { "kind": "time", "everySeconds": 0 }, "action": { "kind": "wakeAssistant", "text": "x" } })));
        assert!(refused(json!({ "source": { "kind": "time", "at": "tomorrow" }, "action": { "kind": "wakeAssistant", "text": "x" } })));
        assert!(refused(json!({ "source": { "kind": "event", "event": " " }, "action": { "kind": "wakeAssistant", "text": "x" } })));
        assert!(refused(json!({ "source": { "kind": "manual" }, "action": { "kind": "wakeAssistant", "text": "" } })));
        assert!(refused(json!({ "source": { "kind": "manual" }, "action": { "kind": "startTask", "workspace": "", "text": "x" } })));
        // The Assistant's proposal starts as a proposal, whatever state it asks for.
        let proposal = triggers
            .create(BY_ASSISTANT, input(json!({ "state": "enabled", "source": { "kind": "manual" }, "action": { "kind": "wakeAssistant", "text": "x" } })))
            .unwrap();
        assert_eq!(proposal.state, TriggerState::Proposed);
    }
}
