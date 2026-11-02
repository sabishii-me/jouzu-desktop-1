use std::path::Path;

use serde_json::{json, Value};

pub fn list(path: &str) -> Result<Value, String> {
    let directory = Path::new(path)
        .canonicalize()
        .map_err(|_| "That folder is not available.".to_string())?;
    if !directory.is_dir() {
        return Err("That folder is not available.".to_string());
    }
    let read = std::fs::read_dir(&directory)
        .map_err(|_| "The folder could not be read.".to_string())?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let metadata = entry.metadata().ok();
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "isDir": metadata.as_ref().map(|value| value.is_dir()).unwrap_or(false),
            "size": metadata.as_ref().map(|value| value.len()).unwrap_or(0),
        }));
    }
    entries.sort_by(|a, b| {
        let left = a.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        let right = b.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        right.cmp(&left).then(
            a.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase()
                .cmp(
                    &b.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase(),
                ),
        )
    });
    Ok(json!({ "entries": entries, "path": directory.to_string_lossy() }))
}
