//! Each session's runs: the one record of how a session's latest run went.
//!
//! The host writes it as runs start and end, keyed by the session's file, and
//! keeps it in the host home so it outlives both the session's place in the
//! host's table (an idle session gives its runtime back after a minute) and
//! the host itself. Everything that asks how a run ended reads it here: the
//! session list's marks (#212) and a task's state. Nobody keeps a copy.
//!
//! A run still marked running when the host starts was cut off when the host
//! went away (the app quit, the machine slept and died); it is recorded so at
//! once, before anything reads it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The run finished and its last reply came back.
    Done,
    /// The run ended in an error: the last reply failed, the runtime refused
    /// the message, or the runtime went away.
    Failed,
    /// Someone stopped it.
    Stopped,
    /// The host went away while it ran.
    CutOff,
}

impl Outcome {
    /// Outcomes the session list marks until someone sees them (#212). A run
    /// that was stopped or cut off lists like a session at rest.
    fn marked(self) -> bool {
        matches!(self, Outcome::Done | Outcome::Failed)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Running {
    turn_id: String,
    started_at: String,
}

/// A session's record: its latest ended run, and the run going on now.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
    /// A client showed the session since that run ended.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    seen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    running: Option<Running>,
}

pub struct SessionRuns {
    /// Where the records are kept; none in tests that need no file.
    path: Option<PathBuf>,
    records: Mutex<BTreeMap<String, Record>>,
    /// Sessions whose run was found cut off when the host started.
    cut_off: Vec<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl SessionRuns {
    pub fn new(path: Option<PathBuf>) -> Self {
        let mut records: BTreeMap<String, Record> = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        // A session whose file is gone has no runs to tell of.
        records.retain(|session, _| {
            let file = std::path::Path::new(session);
            !file.is_absolute() || file.exists()
        });
        let mut cut_off = Vec::new();
        let at = now();
        for (session, record) in records.iter_mut() {
            if let Some(running) = record.running.take() {
                *record = Record {
                    outcome: Some(Outcome::CutOff),
                    started_at: Some(running.started_at),
                    ended_at: Some(at.clone()),
                    seen: false,
                    running: None,
                };
                cut_off.push(session.clone());
            }
        }
        let runs = Self { path, records: Mutex::new(records), cut_off };
        if !runs.cut_off.is_empty() {
            runs.save(&runs.lock());
        }
        runs
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Record>> {
        self.records.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, records: &BTreeMap<String, Record>) {
        let Some(path) = &self.path else { return };
        let Ok(bytes) = serde_json::to_vec_pretty(records) else { return };
        let temp = path.with_extension("json.tmp");
        let _ = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    }

    /// A run of the session saved at `session` started (or started running).
    pub fn started(&self, session: &str, turn_id: &str, at: &str) {
        let mut records = self.lock();
        let record = records.entry(session.to_string()).or_default();
        if record.running.as_ref().is_some_and(|running| running.turn_id == turn_id) {
            return;
        }
        record.running = Some(Running { turn_id: turn_id.to_string(), started_at: at.to_string() });
        self.save(&records);
    }

    /// The turn did not run after all (its message went back to the queue, or
    /// an extension handled a command): the session's last run stands.
    pub fn did_not_run(&self, session: &str, turn_id: &str) {
        let mut records = self.lock();
        let Some(record) = records.get_mut(session) else { return };
        if record.running.as_ref().is_some_and(|running| running.turn_id == turn_id) {
            record.running = None;
            self.save(&records);
        }
    }

    /// A run of the session ended. `shown`: a client showed the session then.
    pub fn ended(&self, session: &str, outcome: Outcome, ended_at: &str, shown: bool) {
        let mut records = self.lock();
        let record = records.entry(session.to_string()).or_default();
        let started_at = record.running.take().map(|running| running.started_at);
        let next = Record {
            outcome: Some(outcome),
            started_at,
            ended_at: Some(ended_at.to_string()),
            seen: shown,
            running: None,
        };
        if *record != next {
            *record = next;
            self.save(&records);
        }
    }

    /// A client shows the session now. Returns whether the list marked it.
    pub fn seen(&self, session: &str) -> bool {
        let mut records = self.lock();
        let Some(record) = records.get_mut(session).filter(|record| !record.seen && record.outcome.is_some()) else {
            return false;
        };
        let marked = record.outcome.is_some_and(Outcome::marked);
        record.seen = true;
        self.save(&records);
        marked
    }

    /// `{ outcome, endedAt }` for the list's mark: a run that finished or
    /// failed and nobody has seen end, else null.
    pub fn view(&self, session: &str) -> Value {
        self.lock()
            .get(session)
            .filter(|record| !record.seen)
            .and_then(|record| Some((record.outcome.filter(|outcome| outcome.marked())?, record.ended_at.clone()?)))
            .map(|(outcome, ended_at)| json!({ "outcome": outcome, "endedAt": ended_at }))
            .unwrap_or(Value::Null)
    }

    /// How the session's latest run ended, or None while one runs (or none ever did).
    pub fn last(&self, session: &str) -> Option<Outcome> {
        self.lock().get(session).filter(|record| record.running.is_none()).and_then(|record| record.outcome)
    }

    /// A run of the session is going on.
    pub fn running(&self, session: &str) -> bool {
        self.lock().get(session).is_some_and(|record| record.running.is_some())
    }

    /// Sessions whose run the host's last exit cut off.
    pub fn cut_off(&self) -> &[String] {
        &self.cut_off
    }
}

#[cfg(test)]
mod tests {
    use super::{Outcome, SessionRuns};
    use serde_json::json;

    #[test]
    fn a_run_ending_unseen_is_marked_until_shown() {
        let runs = SessionRuns::new(None);
        runs.ended("a", Outcome::Done, "2026-11-21T00:00:00.000Z", false);
        assert_eq!(runs.view("a"), json!({ "outcome": "done", "endedAt": "2026-11-21T00:00:00.000Z" }));
        assert!(runs.seen("a"));
        assert_eq!(runs.view("a"), serde_json::Value::Null);
        assert!(!runs.seen("a"));
        // Seen is not forgotten: the run still ended done.
        assert_eq!(runs.last("a"), Some(Outcome::Done));
    }

    #[test]
    fn a_run_ending_in_view_clears_an_older_mark() {
        let runs = SessionRuns::new(None);
        runs.ended("a", Outcome::Failed, "t1", false);
        runs.ended("a", Outcome::Done, "t2", true);
        assert_eq!(runs.view("a"), serde_json::Value::Null);
    }

    #[test]
    fn a_stopped_run_is_recorded_but_never_marked() {
        let runs = SessionRuns::new(None);
        runs.ended("a", Outcome::Failed, "t1", false);
        runs.started("a", "turn-2", "t2");
        runs.ended("a", Outcome::Stopped, "t3", false);
        assert_eq!(runs.view("a"), serde_json::Value::Null);
        assert_eq!(runs.last("a"), Some(Outcome::Stopped));
        assert!(!runs.seen("a"));
    }

    #[test]
    fn a_turn_that_did_not_run_leaves_the_last_run() {
        let runs = SessionRuns::new(None);
        runs.ended("a", Outcome::Done, "t1", true);
        runs.started("a", "turn-2", "t2");
        assert_eq!(runs.last("a"), None);
        runs.did_not_run("a", "turn-2");
        assert_eq!(runs.last("a"), Some(Outcome::Done));
    }

    #[test]
    fn records_outlive_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-runs.json");
        SessionRuns::new(Some(path.clone())).ended("a", Outcome::Failed, "t", false);
        assert_eq!(SessionRuns::new(Some(path)).view("a")["outcome"], "failed");
    }

    #[test]
    fn a_run_going_on_when_the_host_went_away_was_cut_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-runs.json");
        SessionRuns::new(Some(path.clone())).started("a", "turn-1", "t");
        let runs = SessionRuns::new(Some(path.clone()));
        assert_eq!(runs.cut_off(), ["a".to_string()]);
        assert_eq!(runs.last("a"), Some(Outcome::CutOff));
        assert_eq!(runs.view("a"), serde_json::Value::Null);
        // Said once: the next start finds nothing running.
        assert!(SessionRuns::new(Some(path)).cut_off().is_empty());
    }

    #[test]
    fn marks_written_before_runs_were_recorded_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-runs.json");
        std::fs::write(&path, r#"{"a":{"outcome":"done","endedAt":"t"}}"#).unwrap();
        assert_eq!(SessionRuns::new(Some(path)).view("a"), json!({ "outcome": "done", "endedAt": "t" }));
    }
}
