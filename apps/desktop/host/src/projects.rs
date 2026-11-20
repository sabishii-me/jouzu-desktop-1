//! Projects: the user's own grouping of folders, sessions and tasks.
//!
//! A project is a name, a description (its long-lived notes) and links.
//! It owns nothing: folders, sessions and tasks stay where they are, and a
//! link is only an id the host checks exists when it is saved. A folder or
//! session can be in many projects. Tasks do not know their projects; only
//! this store does.
//!
//! Ported from the Assistant experiment (#204), without its Assistant run.

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    session::{session_id_for_path, ApiError, SessionManager},
    tasks::TaskManager,
};

const MAX_PROJECTS: usize = 200;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    projects: Vec<Project>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub task_ids: Vec<String>,
}

pub struct ProjectStore {
    sessions: Arc<SessionManager>,
    tasks: Arc<TaskManager>,
    file: PathBuf,
    /// One change at a time: read, check, write, then show.
    lock: Mutex<()>,
}

impl ProjectStore {
    pub fn new(sessions: Arc<SessionManager>, tasks: Arc<TaskManager>) -> Arc<Self> {
        let file = sessions.home().join("projects.json");
        Arc::new(Self { sessions, tasks, file, lock: Mutex::new(()) })
    }

    fn load(&self) -> Result<Store, ApiError> {
        match std::fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| ApiError::internal(format!("Cannot read projects: {error}"))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
            Err(error) => Err(ApiError::internal(error.to_string())),
        }
    }

    fn save(&self, store: &Store) -> Result<(), ApiError> {
        let bytes = serde_json::to_vec_pretty(store).map_err(|error| ApiError::internal(error.to_string()))?;
        let temp = self.file.with_extension("json.tmp");
        std::fs::write(&temp, bytes)
            .and_then(|_| std::fs::rename(&temp, &self.file))
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    /// Sessions by a stable id: a saved one by its file, so a link survives
    /// the session being closed and opened again. No previews, no messages.
    fn session_index(&self) -> Vec<Value> {
        let mut entries = self.sessions.persisted(None, true);
        entries.extend(self.sessions.list());
        let mut known = BTreeMap::new();
        for mut entry in entries {
            let id = entry
                .get("sessionPath")
                .and_then(Value::as_str)
                .map(session_id_for_path)
                .or_else(|| entry.get("sessionId").and_then(Value::as_str).map(str::to_string));
            if let Some(id) = id {
                entry["sessionId"] = json!(id);
                known.insert(id, entry);
            }
        }
        known
            .into_values()
            .map(|entry| {
                let mut value = json!({});
                for key in ["sessionId", "title", "workspacePath", "status", "sessionPath"] {
                    if let Some(field) = entry.get(key) {
                        value[key] = field.clone();
                    }
                }
                value
            })
            .collect()
    }

    /// The stable id for a session id a caller gave: a live session's id is
    /// turned into its file's id once it has one.
    fn stable_session_id(&self, id: &str) -> String {
        self.sessions
            .get(id)
            .and_then(|session| session.saved_path())
            .map(|path| session_id_for_path(&path))
            .unwrap_or_else(|| id.to_string())
    }

    fn validate(&self, project: &Project, client: &str) -> Result<(), ApiError> {
        if project.name.trim().is_empty()
            || project.name.len() > 200
            || project.description.len() > 8000
            || project.workspace_ids.len() > 100
            || project.session_ids.len() > 300
            || project.task_ids.len() > 500
        {
            return Err(ApiError::bad_request("Invalid project"));
        }
        let workspaces = self.sessions.workspaces();
        for id in &project.workspace_ids {
            if !workspaces.iter().any(|value| value.get("id").and_then(Value::as_str) == Some(id)) {
                return Err(ApiError::bad_request(format!("Unknown workspace {id}")));
            }
        }
        let sessions = self.session_index();
        for id in &project.session_ids {
            if !sessions.iter().any(|value| value.get("sessionId").and_then(Value::as_str) == Some(id)) {
                return Err(ApiError::bad_request(format!("Unknown session {id}")));
            }
        }
        for id in &project.task_ids {
            self.tasks
                .get(client, id)
                .map_err(|_| ApiError::bad_request(format!("Unknown task {id}")))?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Value, ApiError> {
        let _lock = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let store = self.load()?;
        Ok(json!({
            "projects": store.projects,
            "workspaces": self.sessions.workspaces(),
            "sessions": self.session_index(),
        }))
    }

    /// Creates a project (`id` None) or replaces one. `client` owns the tasks
    /// it may link.
    pub fn save_project(&self, client: &str, mut project: Project, id: Option<&str>) -> Result<Value, ApiError> {
        let _lock = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        project.session_ids = project.session_ids.iter().map(|id| self.stable_session_id(id)).collect();
        let mut seen = std::collections::HashSet::new();
        project.session_ids.retain(|id| seen.insert(id.clone()));
        self.validate(&project, client)?;
        let mut store = self.load()?;
        let saved = commit_project(&mut store, project, id, |candidate| self.save(candidate))?;
        crate::log(self.sessions.home(), "info", "project.saved", json!({ "projectId": saved["id"] }));
        Ok(saved)
    }

    pub fn delete_project(&self, id: &str) -> Result<(), ApiError> {
        let _lock = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut store = self.load()?;
        let before = store.projects.len();
        store.projects.retain(|project| project.id != id);
        if store.projects.len() == before {
            return Err(not_found());
        }
        self.save(&store)?;
        crate::log(self.sessions.home(), "info", "project.deleted", json!({ "projectId": id }));
        Ok(())
    }
}

fn not_found() -> ApiError {
    ApiError::new(axum::http::StatusCode::NOT_FOUND, "project-not-found", "No such project", false)
}

/// Applies the change to a copy and shows it only once it is written: a
/// failed write leaves both the file and what callers see unchanged.
fn commit_project(
    store: &mut Store,
    mut project: Project,
    id: Option<&str>,
    persist: impl FnOnce(&Store) -> Result<(), ApiError>,
) -> Result<Value, ApiError> {
    let mut candidate = store.clone();
    if let Some(id) = id {
        let existing = candidate
            .projects
            .iter_mut()
            .find(|existing| existing.id == id)
            .ok_or_else(not_found)?;
        project.id = id.to_string();
        *existing = project.clone();
    } else {
        if store.projects.len() >= MAX_PROJECTS {
            return Err(ApiError::bad_request("Project limit reached"));
        }
        project.id = format!("project-{}", &crate::new_token()[..16]);
        candidate.projects.push(project.clone());
    }
    persist(&candidate)?;
    *store = candidate;
    Ok(json!(project))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Project {
        serde_json::from_value(json!({ "name": "Shared", "workspaceIds": ["w"], "sessionIds": ["s"] })).unwrap()
    }

    #[test]
    fn a_failed_save_changes_neither_the_file_nor_what_is_shown() {
        let mut store = Store::default();
        assert!(commit_project(&mut store, project(), None, |_| Err(ApiError::internal("write failed"))).is_err());
        assert!(store.projects.is_empty());
        commit_project(&mut store, project(), None, |candidate| {
            assert_eq!(candidate.projects.len(), 1);
            Ok(())
        })
        .unwrap();
        commit_project(&mut store, project(), None, |_| Ok(())).unwrap();
        assert_ne!(store.projects[0].id, store.projects[1].id);
    }

    #[test]
    fn requests_cannot_carry_other_fields() {
        assert!(serde_json::from_value::<Project>(json!({ "name": "x", "workspacePath": "/tmp" })).is_err());
    }

    #[tokio::test]
    async fn links_must_name_things_that_exist() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionManager::new(None, home.path().to_path_buf(), home.path().join("data"), None, 10, None));
        let added = sessions.add_workspaces(&[workspace.path().to_string_lossy().into_owned()]).unwrap();
        let workspace_id = added
            .iter()
            .find(|value| {
                value["path"].as_str().and_then(|path| std::path::Path::new(path).canonicalize().ok())
                    == workspace.path().canonicalize().ok()
            })
            .and_then(|value| value["id"].as_str())
            .unwrap()
            .to_string();
        let tasks = TaskManager::new(sessions.clone(), 4);
        let store = ProjectStore::new(sessions, tasks);
        let good: Project = serde_json::from_value(json!({ "name": "Desktop", "workspaceIds": [workspace_id] })).unwrap();
        let saved = store.save_project("desktop", good, None).unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        for bad in [
            json!({ "name": "x", "workspaceIds": ["windows:/nowhere"] }),
            json!({ "name": "x", "sessionIds": ["nope"] }),
            json!({ "name": "x", "taskIds": ["task-nope"] }),
            json!({ "name": " " }),
        ] {
            let bad: Project = serde_json::from_value(bad).unwrap();
            assert!(store.save_project("desktop", bad, Some(&id)).is_err());
        }
        assert_eq!(store.snapshot().unwrap()["projects"][0]["name"], "Desktop");
        store.delete_project(&id).unwrap();
        assert!(store.snapshot().unwrap()["projects"].as_array().unwrap().is_empty());
        assert_eq!(store.delete_project(&id).unwrap_err().code, "project-not-found");
    }
}
