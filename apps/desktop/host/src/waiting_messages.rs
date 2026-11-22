//! Messages still waiting in a session, kept across a host restart (#162).
//!
//! The host owns a session's waiting list: messages sent while a reply ran,
//! messages returned after Stop, and messages an extension (Flow) holds. Until
//! the runtime uses one, it is in no file. The host keeps each saved session's
//! list here, keyed by its file as the session list keys it, and updates the
//! entry whenever the list changes. A session opened for that file again (after
//! the host restarted, or in place of one that ended) gets the messages back,
//! paused: the user continues or discards them. A message is never sent again
//! on its own, and never dropped without the user seeing it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One waiting message: the prompt the runtime will get (text, images and the
/// client's message id) and the user's history row, when it has one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Waiting {
    pub prompt: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<Value>,
}

pub struct WaitingMessages {
    /// Where the lists are kept; none in tests that need no file.
    path: Option<PathBuf>,
    lists: Mutex<BTreeMap<String, Vec<Waiting>>>,
}

impl WaitingMessages {
    /// Lists for session files that are gone are dropped: nothing can open them.
    pub fn new(path: Option<PathBuf>) -> Self {
        let mut lists: BTreeMap<String, Vec<Waiting>> = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let before = lists.len();
        lists.retain(|session, list| !list.is_empty() && Path::new(session).is_file());
        let store = Self { path, lists: Mutex::new(BTreeMap::new()) };
        if lists.len() != before {
            store.save(&lists);
        }
        *store.lock() = lists;
        store
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<Waiting>>> {
        self.lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, lists: &BTreeMap<String, Vec<Waiting>>) {
        let Some(path) = &self.path else { return };
        let Ok(bytes) = serde_json::to_vec(lists) else { return };
        let temp = path.with_extension("json.tmp");
        let _ = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    }

    /// The session saved at `session` has these messages waiting now (none
    /// removes its entry). Written only when the list changed.
    pub fn set(&self, session: &str, list: Vec<Waiting>) {
        let mut lists = self.lock();
        let changed = if list.is_empty() {
            lists.remove(session).is_some()
        } else if lists.get(session) == Some(&list) {
            false
        } else {
            lists.insert(session.to_string(), list);
            true
        };
        if changed {
            self.save(&lists);
        }
    }

    /// The messages waiting for the session saved at `session`.
    pub fn get(&self, session: &str) -> Vec<Waiting> {
        self.lock().get(session).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{Waiting, WaitingMessages};
    use serde_json::json;

    fn waiting(text: &str) -> Waiting {
        Waiting { prompt: json!({ "type": "prompt", "id": text, "message": text }), row: None }
    }

    #[test]
    fn waiting_messages_outlive_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("s.jsonl");
        std::fs::write(&session, "{}\n").unwrap();
        let session = session.to_string_lossy().into_owned();
        let path = dir.path().join("waiting-messages.json");
        WaitingMessages::new(Some(path.clone())).set(&session, vec![waiting("a"), waiting("b")]);
        assert_eq!(WaitingMessages::new(Some(path.clone())).get(&session), vec![waiting("a"), waiting("b")]);
        WaitingMessages::new(Some(path.clone())).set(&session, Vec::new());
        assert!(WaitingMessages::new(Some(path)).get(&session).is_empty());
    }

    #[test]
    fn a_list_for_a_session_file_that_is_gone_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("gone.jsonl").to_string_lossy().into_owned();
        let path = dir.path().join("waiting-messages.json");
        WaitingMessages::new(Some(path.clone())).set(&session, vec![waiting("a")]);
        assert!(WaitingMessages::new(Some(path.clone())).get(&session).is_empty());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{}");
    }
}
