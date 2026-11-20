//! Runs that ended while nobody was looking.
//!
//! A session's run can end while no client shows it (it ran in the background,
//! or the window was on another session). Until a client shows that session
//! again, every client lists it as finished, failed or stopped (#212). The host
//! keeps one entry per such session, keyed by its file, and drops it as soon as
//! any client shows the session. The entries outlive the session's place in the
//! host's table (an idle session gives its runtime back after a minute) and the
//! host itself, so they are kept in the host home.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The run finished and its last reply came back.
    Done,
    /// The run ended in an error: the last reply failed, the runtime refused
    /// the message, or the runtime went away.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Mark {
    outcome: Outcome,
    #[serde(rename = "endedAt")]
    ended_at: String,
}

pub struct RunMarks {
    /// Where the marks are kept; none in tests that need no file.
    path: Option<PathBuf>,
    marks: Mutex<BTreeMap<String, Mark>>,
}

impl RunMarks {
    pub fn new(path: Option<PathBuf>) -> Self {
        let marks = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { path, marks: Mutex::new(marks) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Mark>> {
        self.marks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, marks: &BTreeMap<String, Mark>) {
        let Some(path) = &self.path else { return };
        let Ok(bytes) = serde_json::to_vec_pretty(marks) else { return };
        let temp = path.with_extension("json.tmp");
        let _ = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    }

    /// A run of the session saved at `session` ended. Shown by a client when it
    /// ended: nothing to mark, and an older mark is gone too (the client sees
    /// the session as it is now).
    pub fn ended(&self, session: &str, outcome: Outcome, ended_at: &str, shown: bool) {
        let mut marks = self.lock();
        let changed = if shown {
            marks.remove(session).is_some()
        } else {
            let mark = Mark { outcome, ended_at: ended_at.to_string() };
            marks.insert(session.to_string(), mark.clone()) != Some(mark)
        };
        if changed {
            self.save(&marks);
        }
    }

    /// A client shows the session now. Returns whether it had a mark.
    pub fn seen(&self, session: &str) -> bool {
        let mut marks = self.lock();
        let removed = marks.remove(session).is_some();
        if removed {
            self.save(&marks);
        }
        removed
    }

    /// `{ outcome, endedAt }` for a run of this session nobody has seen end, else null.
    pub fn view(&self, session: &str) -> Value {
        self.lock()
            .get(session)
            .map(|mark| json!({ "outcome": mark.outcome, "endedAt": mark.ended_at }))
            .unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::{Outcome, RunMarks};
    use serde_json::json;

    #[test]
    fn a_run_ending_unseen_is_marked_until_shown() {
        let marks = RunMarks::new(None);
        marks.ended("a", Outcome::Done, "2026-11-21T00:00:00.000Z", false);
        assert_eq!(marks.view("a"), json!({ "outcome": "done", "endedAt": "2026-11-21T00:00:00.000Z" }));
        assert!(marks.seen("a"));
        assert_eq!(marks.view("a"), serde_json::Value::Null);
        assert!(!marks.seen("a"));
    }

    #[test]
    fn a_run_ending_in_view_clears_an_older_mark() {
        let marks = RunMarks::new(None);
        marks.ended("a", Outcome::Failed, "t1", false);
        marks.ended("a", Outcome::Done, "t2", true);
        assert_eq!(marks.view("a"), serde_json::Value::Null);
    }

    #[test]
    fn marks_outlive_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-runs.json");
        RunMarks::new(Some(path.clone())).ended("a", Outcome::Failed, "t", false);
        assert_eq!(RunMarks::new(Some(path)).view("a")["outcome"], "failed");
    }
}
