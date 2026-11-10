//! The model snapshot the UI selects from.
//!
//! The snapshot comes from Jouzu through the control adapter (`status.models` and the
//! saved defaults). The host never reads `cache/model-catalog/**` and never merges
//! accounts; it caches the adapter's answer so a page reload costs no process.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{json, Value};

use crate::{
    control::ControlManager,
    session::ApiError,
};

pub struct Models {
    path: PathBuf,
    cached: Mutex<Option<Value>>,
}

impl Models {
    pub fn new(host_home: &Path) -> Self {
        Self {
            path: host_home.join("host-state").join("models.json"),
            cached: Mutex::new(None),
        }
    }

    fn load(&self) -> Option<Value> {
        if let Some(value) = self
            .cached
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            return Some(value);
        }
        let bytes = std::fs::read(&self.path).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        if !value.get("models").map(Value::is_array).unwrap_or(false) {
            return None;
        }
        *self
            .cached
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.clone());
        Some(value)
    }

    fn store(&self, value: Value) -> Value {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
            if std::fs::write(&temp, bytes).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
        *self
            .cached
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.clone());
        value
    }

    /// The snapshot, built once from the adapter when nothing is cached yet.
    pub async fn get(&self, control: &ControlManager) -> Result<Value, ApiError> {
        if let Some(value) = self.load() {
            return Ok(value);
        }
        self.enumerate(control).await
    }

    /// Refresh through Jouzu, then re-enumerate. A failure keeps the previous snapshot.
    pub async fn refresh(&self, control: &ControlManager) -> Result<Value, ApiError> {
        if let Err(error) = control
            .request(json!({ "action": "refresh-catalogs" }))
            .await
        {
            return match self.load() {
                Some(mut previous) => {
                    previous["stale"] = Value::Bool(true);
                    previous["warning"] = Value::String(error.message.clone());
                    Ok(previous)
                }
                None => Err(error),
            };
        }
        self.enumerate(control).await
    }

    async fn enumerate(&self, control: &ControlManager) -> Result<Value, ApiError> {
        let status = control
            .request(json!({ "action": "status" }))
            .await
            .map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "models-unavailable",
                    error.message,
                    true,
                )
            })?;
        let models = status
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if models.is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "models-unavailable",
                "No usable model is configured yet",
                true,
            ));
        }
        Ok(self.store(json!({
            "generatedAt": now(),
            "models": models,
            "defaultProvider": status.get("defaultProvider").cloned().unwrap_or(Value::Null),
            "defaultModel": status.get("defaultModel").cloned().unwrap_or(Value::Null),
            "stale": false,
        })))
    }

    /// Whether the pair exists in the current snapshot.
    pub fn allows(&self, provider: &str, id: &str) -> bool {
        let Some(snapshot) = self.load() else {
            return false;
        };
        snapshot
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models.iter().any(|model| {
                    model.get("provider").and_then(Value::as_str) == Some(provider)
                        && model.get("id").and_then(Value::as_str) == Some(id)
                })
            })
            .unwrap_or(false)
    }

    /// The name for a pair, for the session model state.
    pub fn display_name(&self, provider: &str, id: &str) -> Option<String> {
        let snapshot = self.load()?;
        snapshot
            .get("models")
            .and_then(Value::as_array)?
            .iter()
            .find(|model| {
                model.get("provider").and_then(Value::as_str) == Some(provider)
                    && model.get("id").and_then(Value::as_str) == Some(id)
            })
            .and_then(|model| model.get("name").and_then(Value::as_str))
            .map(ToString::to_string)
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
