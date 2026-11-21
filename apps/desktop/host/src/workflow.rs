//! jouzu's workflow definitions (`agents.json` in the runtime home): which
//! agent roles exist, their model tier, tools and instructions.
//!
//! The runtime owns the format and reads the file when it uses a role. The
//! host reads and writes it for the Assistant (and later the UI) with the
//! runtime's own rules checked first, never over a change it has not seen
//! (revision), never while the runtime holds its lock, and keeps every
//! version it replaces so the user can restore it.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::session::ApiError;

/// jouzu 0.2.5 `subagents/roles.js`.
const AGENT_TOOLS: [&str; 8] = ["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"];
const READ_TOOLS: [&str; 4] = ["read", "grep", "find", "ls"];
const THINKING: [&str; 8] = ["same", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub struct Workflow {
    file: PathBuf,
    versions: PathBuf,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(axum::http::StatusCode::BAD_REQUEST, "workflow-invalid", message, false)
}

fn revision(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn text(value: &Value, label: &str, max: usize, empty: bool) -> Result<String, ApiError> {
    let text = value.as_str().ok_or_else(|| invalid(format!("{label} must be text")))?;
    if (!empty && text.trim().is_empty()) || text.chars().count() > max || text.contains('\0') {
        return Err(invalid(format!("{label} must be {} at most {max} characters", if empty { "" } else { "non-empty and" })));
    }
    Ok(text.to_string())
}

/// The runtime's own checks (`parseAgentConfig`), so a bad file is refused
/// here with a reason instead of breaking the runtime later.
pub fn validate(config: &Value) -> Result<Value, ApiError> {
    if config["schemaVersion"] != 1 {
        return Err(invalid("schemaVersion must be 1"));
    }
    let roles = config["roles"].as_array().ok_or_else(|| invalid("roles must be a list"))?;
    if roles.len() > 64 {
        return Err(invalid("At most 64 roles"));
    }
    let concurrent = config["maxConcurrent"].as_u64().filter(|value| (1..=32).contains(value));
    let concurrent = concurrent.ok_or_else(|| invalid("maxConcurrent must be 1-32"))?;
    let writers = match &config["workspaceWriters"] {
        Value::Null => "parallel".to_string(),
        Value::String(value) if value == "parallel" || value == "serialize" => value.clone(),
        _ => return Err(invalid("workspaceWriters must be serialize or parallel")),
    };
    let mut ids = std::collections::HashSet::new();
    let mut checked = Vec::new();
    for role in roles {
        let id = text(&role["id"], "Role id", 64, false)?;
        let valid_id = id.chars().next().is_some_and(|first| first.is_ascii_lowercase())
            && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !valid_id || !ids.insert(id.clone()) {
            return Err(invalid("Role ids are unique lowercase names of letters, digits, - and _"));
        }
        let placement = role["placement"].as_str().filter(|value| ["main", "child", "both"].contains(value));
        let placement = placement.ok_or_else(|| invalid(format!("{id}: placement is main, child or both")))?;
        let judging = role["judging"].as_bool().ok_or_else(|| invalid(format!("{id}: judging must be true or false")))?;
        let tools = role["tools"].as_array().ok_or_else(|| invalid(format!("{id}: tools must be a list")))?;
        let mut names: Vec<String> = Vec::new();
        for tool in tools {
            let name = tool.as_str().filter(|name| AGENT_TOOLS.contains(name));
            let name = name.ok_or_else(|| invalid(format!("{id}: tools are {}", AGENT_TOOLS.join(", "))))?;
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_string());
            }
        }
        if judging && placement != "child" {
            return Err(invalid(format!("{id}: a reviewing role runs as a child, for a fresh context")));
        }
        if judging && names.iter().any(|name| !READ_TOOLS.contains(&name.as_str())) {
            return Err(invalid(format!("{id}: a reviewing role may use only read, grep, find and ls")));
        }
        let thinking = role["thinking"].as_str().filter(|value| THINKING.contains(value));
        let thinking = thinking.ok_or_else(|| invalid(format!("{id}: thinking is one of {}", THINKING.join(", "))))?;
        let timeout = role["timeoutSeconds"].as_u64().filter(|value| (10..=2_147_483).contains(value));
        let timeout = timeout.ok_or_else(|| invalid(format!("{id}: timeoutSeconds must be 10-2147483")))?;
        let turns = role["maxTurns"].as_u64().filter(|value| *value >= 1 && *value <= 9_007_199_254_740_991);
        let turns = turns.ok_or_else(|| invalid(format!("{id}: maxTurns must be at least 1")))?;
        checked.push(json!({
            "id": id,
            "description": text(&role["description"], "Description", 300, true)?,
            "model": text(&role["model"], "Model", 300, false)?,
            "instructions": text(&role["instructions"], "Instructions", 32_000, false)?,
            "placement": placement,
            "judging": judging,
            "tools": names,
            "thinking": thinking,
            "timeoutSeconds": timeout,
            "maxTurns": turns,
        }));
    }
    Ok(json!({ "schemaVersion": 1, "maxConcurrent": concurrent, "workspaceWriters": writers, "roles": checked }))
}

impl Workflow {
    pub fn new(runtime_home: &Path, host_home: &Path) -> Self {
        Self { file: runtime_home.join("agents.json"), versions: host_home.join("workflow-versions") }
    }

    /// The saved definitions, or none: the runtime then uses its defaults.
    pub fn read(&self) -> Result<Value, ApiError> {
        match std::fs::read(&self.file) {
            Ok(bytes) => {
                let config: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| invalid(format!("agents.json is not valid JSON: {error}")))?;
                Ok(json!({ "config": config, "revision": revision(&bytes), "isDefault": false }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(json!({ "config": Value::Null, "revision": "none", "isDefault": true }))
            }
            Err(error) => Err(ApiError::internal(error.to_string())),
        }
    }

    fn current_revision(&self) -> Result<String, ApiError> {
        match std::fs::read(&self.file) {
            Ok(bytes) => Ok(revision(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("none".into()),
            Err(error) => Err(ApiError::internal(error.to_string())),
        }
    }

    /// Replaces the definitions when nobody changed them since `expected`.
    /// The replaced version is kept.
    pub fn save(&self, config: &Value, expected: &str, by: &str) -> Result<Value, ApiError> {
        let checked = validate(config)?;
        let mut bytes = serde_json::to_vec_pretty(&checked).map_err(|error| ApiError::internal(error.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() > 2_100_000 {
            return Err(invalid("The definitions must fit in 2 MB"));
        }
        if self.file.with_extension("json.lock").exists() {
            return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "workflow-busy", "A session is saving agents. Try again.", true));
        }
        if self.current_revision()? != expected {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "workflow-changed",
                "The definitions changed since they were read. Read them again.",
                false,
            ));
        }
        self.keep_current(by)?;
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| ApiError::internal(error.to_string()))?;
        }
        let temp = self.file.with_extension("json.tmp");
        std::fs::write(&temp, &bytes)
            .and_then(|_| std::fs::rename(&temp, &self.file))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(json!({ "config": checked, "revision": revision(&bytes) }))
    }

    /// Copies the current file into the version folder before it is replaced.
    fn keep_current(&self, by: &str) -> Result<(), ApiError> {
        let Ok(bytes) = std::fs::read(&self.file) else { return Ok(()) };
        std::fs::create_dir_all(&self.versions).map_err(|error| ApiError::internal(error.to_string()))?;
        let name = format!("{}-{}.json", Utc::now().format("%Y%m%dT%H%M%S%.3fZ"), by);
        std::fs::write(self.versions.join(name), bytes).map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(())
    }

    fn version_names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.versions)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .collect();
        names.sort();
        names
    }

    pub fn versions(&self) -> Value {
        json!({ "versions": self.version_names() })
    }

    /// Puts a kept version back (the current one is kept in turn).
    pub fn restore(&self, version: &str, by: &str) -> Result<Value, ApiError> {
        if !self.version_names().iter().any(|name| name == version) {
            return Err(ApiError::new(axum::http::StatusCode::NOT_FOUND, "version-not-found", "No such version", false));
        }
        let bytes = std::fs::read(self.versions.join(version)).map_err(|error| ApiError::internal(error.to_string()))?;
        let config: Value = serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
        let current = self.current_revision()?;
        self.save(&config, &current, by)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(id: &str) -> Value {
        json!({ "id": id, "description": "", "model": "same", "instructions": "Do it.", "placement": "child",
                "judging": false, "tools": ["read", "bash"], "thinking": "same", "timeoutSeconds": 600, "maxTurns": 50 })
    }

    fn config(roles: Vec<Value>) -> Value {
        json!({ "schemaVersion": 1, "maxConcurrent": 4, "roles": roles })
    }

    #[test]
    fn the_runtime_rules_are_checked_before_writing() {
        assert!(validate(&config(vec![role("coder")])).is_ok());
        let mut reviewer = role("reviewer");
        reviewer["judging"] = json!(true);
        assert!(validate(&config(vec![reviewer.clone()])).is_err(), "a reviewer may not run bash");
        reviewer["tools"] = json!(["read", "grep"]);
        assert!(validate(&config(vec![reviewer.clone()])).is_ok());
        reviewer["placement"] = json!("main");
        assert!(validate(&config(vec![reviewer])).is_err(), "a reviewer runs as a child");
        assert!(validate(&config(vec![role("Coder")])).is_err());
        assert!(validate(&config(vec![role("a"), role("a")])).is_err());
        let mut unknown = role("x");
        unknown["tools"] = json!(["web_fetch"]);
        assert!(validate(&config(vec![unknown])).is_err());
        let mut too_many = config(vec![role("x")]);
        too_many["maxConcurrent"] = json!(64);
        assert!(validate(&too_many).is_err());
    }

    #[test]
    fn saves_only_over_what_was_read_and_keeps_what_it_replaced() {
        let runtime = tempfile::tempdir().unwrap();
        let host = tempfile::tempdir().unwrap();
        let workflow = Workflow::new(runtime.path(), host.path());
        let first = workflow.read().unwrap();
        assert_eq!(first["isDefault"], true);
        let saved = workflow.save(&config(vec![role("coder")]), "none", "assistant").unwrap();
        let stale = workflow.save(&config(vec![role("tester")]), "none", "assistant").unwrap_err();
        assert_eq!(stale.code, "workflow-changed");
        workflow.save(&config(vec![role("tester")]), saved["revision"].as_str().unwrap(), "assistant").unwrap();
        let versions = workflow.versions()["versions"].as_array().unwrap().clone();
        assert_eq!(versions.len(), 1);
        workflow.restore(versions[0].as_str().unwrap(), "desktop").unwrap();
        assert_eq!(workflow.read().unwrap()["config"]["roles"][0]["id"], "coder");
        assert_eq!(workflow.versions()["versions"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_save_waits_for_the_runtime_lock() {
        let runtime = tempfile::tempdir().unwrap();
        let host = tempfile::tempdir().unwrap();
        let workflow = Workflow::new(runtime.path(), host.path());
        std::fs::write(runtime.path().join("agents.json.lock"), "").unwrap();
        assert_eq!(workflow.save(&config(vec![role("coder")]), "none", "assistant").unwrap_err().code, "workflow-busy");
    }
}
