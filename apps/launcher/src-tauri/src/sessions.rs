
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;
const MAX_SESSIONS: usize = 200;
const MAX_PREFIX_BYTES: u64 = 512 * 1024;
const MAX_LINES: usize = 400;
const MAX_TITLE_CHARS: usize = 80;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPreference {
    pinned: bool,
    archived: bool,
    title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    path: String,
    title: String,
    workspace: String,
    updated: u64,
    pinned: bool,
    archived: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowReportRecord {
    pub kind: String,
    pub text: String,
}

#[tauri::command]
pub fn chat_sessions() -> Result<Vec<SessionSummary>, String> {
    let home = crate::runtime::effective_home()?;
    let preferences = read_preferences(&home)?;
    Ok(list_sessions_with_preferences(
        &home.join("state/sessions"),
        &preferences,
    ))
}

#[tauri::command]
pub fn chat_session_update(
    session_path: String,
    pinned: Option<bool>,
    archived: Option<bool>,
    title: Option<String>,
) -> Result<Vec<SessionSummary>, String> {
    let path = validated_session_path(&session_path)?;
    let home = crate::runtime::effective_home()?;
    let key = path.to_string_lossy().into_owned();
    let mut preferences = read_preferences(&home)?;
    let preference = preferences.entry(key).or_default();
    if let Some(value) = pinned {
        preference.pinned = value;
    }
    if let Some(value) = archived {
        preference.archived = value;
    }
    if let Some(value) = title {
        let value = value.trim();
        preference.title = if value.is_empty() {
            None
        } else {
            Some(value.chars().take(MAX_TITLE_CHARS).collect())
        };
    }
    write_preferences(&home, &preferences)?;
    Ok(list_sessions_with_preferences(
        &home.join("state/sessions"),
        &preferences,
    ))
}

fn preferences_path(home: &Path) -> std::path::PathBuf {
    home.join("state/session-preferences.json")
}

fn read_preferences(home: &Path) -> Result<HashMap<String, SessionPreference>, String> {
    let path = preferences_path(home);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(HashMap::new());
    };
    serde_json::from_slice(&bytes).map_err(|_| "Session preferences are invalid".into())
}

fn write_preferences(
    home: &Path,
    preferences: &HashMap<String, SessionPreference>,
) -> Result<(), String> {
    let path = preferences_path(home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?;
    fs::write(&path, &bytes).map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTiming {
    pub model_ms: u64,
    pub tool_ms: u64,
    pub turns: u32,
    pub steps: u32,
    pub output_tokens: u64,
}

#[tauri::command]
pub fn chat_session_timing(session_path: String) -> Result<SessionTiming, String> {
    let path = validated_session_path(&session_path)?;
    Ok(read_session_timing(&path))
}

/// Create a copy of a session with synthetic interrupted results for every
/// assistant tool call that has no result. The original file is never changed.
#[tauri::command]
pub fn chat_session_recover(session_path: String) -> Result<Option<String>, String> {
    let path = validated_session_path(&session_path)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let lines: Vec<&str> = content.lines().filter(|line| !line.trim().is_empty()).collect();
    let mut entries = Vec::with_capacity(lines.len());
    for line in &lines {
        entries.push(serde_json::from_str::<Value>(line).map_err(|_| "Invalid session entry".to_string())?);
    }
    let Some(mut repaired) = recover_entries(&entries)? else { return Ok(None); };
    let directory = path.parent().ok_or("Session directory unavailable")?;
    let stem = path.file_stem().and_then(|value| value.to_str()).ok_or("Invalid session filename")?;
    let recovered_prefix = format!("{stem}-recovered-");
    if let Ok(existing) = fs::read_dir(directory) {
        for entry in existing.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&recovered_prefix) && name.ends_with(".jsonl") && entry.path().is_file() {
                return Ok(Some(entry.path().to_string_lossy().into_owned()));
            }
        }
    }
    let millis = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Clock unavailable")?.as_millis();
    let mut destination = directory.join(format!("{stem}-recovered-{millis}.jsonl"));
    let mut counter = 1;
    while destination.exists() {
        destination = directory.join(format!("{stem}-recovered-{millis}-{counter}.jsonl"));
        counter += 1;
    }
    let mut output = String::new();
    if let Some(header) = repaired.first_mut().and_then(Value::as_object_mut) {
        header.insert("parentSession".into(), Value::String(path.to_string_lossy().into_owned()));
    }
    for entry in repaired {
        output.push_str(&serde_json::to_string(&entry).map_err(|error| error.to_string())?);
        output.push('\n');
    }
    fs::write(&destination, output).map_err(|error| error.to_string())?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn recover_entries(entries: &[Value]) -> Result<Option<Vec<Value>>, String> {
    let Some(header) = entries.first() else { return Ok(None); };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("Session header is invalid".into());
    }
    let mut calls: Vec<(String, String)> = Vec::new();
    let mut results = std::collections::HashSet::new();
    for entry in entries {
        let Some(message) = entry.get("message") else { continue; };
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("toolCall") {
                            if let (Some(id), Some(name)) = (block.get("id").and_then(Value::as_str), block.get("name").and_then(Value::as_str)) {
                                calls.push((id.to_string(), name.to_string()));
                            }
                        }
                    }
                }
            }
            Some("toolResult") => {
                if let Some(id) = message.get("toolCallId").and_then(Value::as_str) {
                    results.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    let pending: Vec<&(String, String)> = calls.iter().filter(|(id, _)| !results.contains(id)).collect();
    if pending.is_empty() { return Ok(None); }
    let mut repaired = entries.to_vec();
    let original_id = header.get("id").and_then(Value::as_str).unwrap_or("session");
    let mut parent = entries.iter().rev().find_map(|entry| entry.get("id").and_then(Value::as_str)).unwrap_or("").to_string();
    let mut used: std::collections::HashSet<String> = entries.iter().filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let base = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Clock unavailable")?.as_millis();
    for (index, (tool_call_id, tool_name)) in pending.iter().enumerate() {
        let mut serial = base + index as u128;
        let mut id = format!("{serial:08x}");
        while used.contains(&id) { serial += 1; id = format!("{serial:08x}"); }
        used.insert(id.clone());
        let timestamp = entries.last().and_then(|entry| entry.get("timestamp")).cloned().unwrap_or(Value::Null);
        repaired.push(serde_json::json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": timestamp,
            "message": {
                "role": "toolResult",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "content": [{ "type": "text", "text": "Interrupted: this tool call had no result. The recovered copy continued without it." }],
                "details": {},
                "isError": true,
                "durationMs": 0,
                "timestamp": base as u64
            }
        }));
        parent = id;
    }
    let mut new_header = header.clone();
    if let Some(object) = new_header.as_object_mut() {
        object.insert("id".into(), Value::String(format!("{original_id}-recovered-{base}")));
    }
    repaired[0] = new_header;
    Ok(Some(repaired))
}

fn validated_session_path(session_path: &str) -> Result<std::path::PathBuf, String> {
    if session_path.contains('\0') || !Path::new(session_path).is_absolute() {
        return Err("Session path must be absolute".into());
    }
    let root = crate::runtime::effective_home()?.join("state").join("sessions");
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let path = fs::canonicalize(session_path).map_err(|error| error.to_string())?;
    if !path.starts_with(&root) || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("Only session files are accepted".into());
    }
    Ok(path)
}

/// Smallest side a provider accepts. A strip thinner than this is refused at attach
/// time; this is the repair path for a session that already contains one.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
fn iso_to_millis(value: &str) -> Option<i64> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let seconds = time_parts.next()?;
    let (second, millis) = seconds.split_once('.').map_or((seconds, "0"), |(second, fraction)| (second, fraction));
    let second = second.parse::<i64>().ok()?;
    let millis = format!("{millis:0<3}").chars().take(3).collect::<String>().parse::<i64>().ok()?;
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

fn read_session_timing(path: &Path) -> SessionTiming {
    let Ok(file) = File::open(path) else { return SessionTiming { model_ms: 0, tool_ms: 0, turns: 0, steps: 0, output_tokens: 0 } };
    let reader = BufReader::new(file.take(32 * 1024 * 1024));
    let mut result = SessionTiming { model_ms: 0, tool_ms: 0, turns: 0, steps: 0, output_tokens: 0 };
    let mut previous_entry_ts: Option<i64> = None;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let entry_ts = value.get("timestamp").and_then(Value::as_str).and_then(iso_to_millis);
        if value.get("type").and_then(Value::as_str) != Some("message") {
            if entry_ts.is_some() { previous_entry_ts = entry_ts; }
            continue;
        }
        let Some(message) = value.get("message") else { continue };
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if role == "toolResult" {
            if let (Some(started), Some(ended)) = (previous_entry_ts, entry_ts) {
                result.tool_ms += ended.saturating_sub(started).max(0) as u64;
            }
        } else if role == "user" {
            result.turns += 1;
        } else if role == "assistant" {
            result.steps += 1;
            result.output_tokens += message.get("usage").and_then(|usage| usage.get("output")).and_then(Value::as_u64).unwrap_or(0);
            if let (Some(started), Some(ended)) = (message.get("timestamp").and_then(Value::as_i64), entry_ts) {
                result.model_ms += ended.saturating_sub(started).max(0) as u64;
            }
        }
        if entry_ts.is_some() { previous_entry_ts = entry_ts; }
    }
    result
}

#[tauri::command]
pub async fn chat_session_messages(
    session_path: String,
    limit: Option<usize>,
) -> Result<Vec<Value>, String> {
    let path = validated_session_path(&session_path)?;
    let messages = tauri::async_runtime::spawn_blocking(move || read_session_messages(&path, limit))
        .await
        .map_err(|_| "Session read failed".to_string())?;
    Ok(messages)
}

#[tauri::command]
pub async fn chat_session_bytes(session_path: String) -> Result<u64, String> {
    let path = validated_session_path(&session_path)?;
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|_| "Session size read failed".to_string())
}

/// Fork at the selected turn: copy the source session up to and including the
/// message at `message_index` into a new session file with `parentSession`.
#[tauri::command]
pub async fn chat_session_branch(
    session_path: String,
    message_index: usize,
) -> Result<String, String> {
    let path = validated_session_path(&session_path)?;
    tauri::async_runtime::spawn_blocking(move || branch_session_file(&path, message_index))
        .await
        .map_err(|_| "Session branch failed".to_string())?
}

fn branch_session_file(source: &Path, message_index: usize) -> Result<String, String> {
    let text = fs::read_to_string(source).map_err(|_| "Session read failed".to_string())?;
    let mut lines = text.lines();
    let header_line = lines.next().ok_or_else(|| "Session is empty".to_string())?;
    let header: Value = serde_json::from_str(header_line).map_err(|_| "Session header is invalid".to_string())?;
    let cwd = header.get("cwd").and_then(Value::as_str).ok_or_else(|| "Session has no workspace".to_string())?;
    let mut kept: Vec<&str> = Vec::new();
    let mut seen = 0usize;
    let mut found = false;
    for line in lines {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        kept.push(line);
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            if seen == message_index {
                found = true;
                break;
            }
            seen += 1;
        }
    }
    if !found {
        return Err("Message not found in session".to_string());
    }
    let directory = source.parent().ok_or_else(|| "Session directory is missing".to_string())?;
    let id = new_session_id();
    let timestamp = iso_timestamp_now();
    let file_name = format!("{}_{}.jsonl", timestamp.replace([':', '.'], "-"), id);
    let target = directory.join(file_name);
    let mut output = String::new();
    output.push_str(&serde_json::json!({
        "type": "session",
        "version": 3,
        "id": id,
        "timestamp": timestamp,
        "cwd": cwd,
        "parentSession": source.to_string_lossy(),
    }).to_string());
    output.push('\n');
    for line in kept {
        output.push_str(line);
        output.push('\n');
    }
    fs::write(&target, output).map_err(|_| "Session branch write failed".to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

fn new_session_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let value = now.wrapping_mul(0x9e3779b97f4a7c15) ^ (pid << 48);
    format!(
        "{:08x}-{:04x}-7{:03x}-{:04x}-{:012x}",
        (value >> 96) as u32,
        (value >> 80) as u16,
        (value >> 68) as u16 & 0x0fff,
        ((value >> 48) as u16 & 0x3fff) | 0x8000,
        value & 0xffff_ffff_ffff
    )
}

fn iso_timestamp_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        year, month, day, remainder / 3600, (remainder % 3600) / 60, remainder % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 } as u32;
    if month <= 2 { year += 1; }
    (year, month, day)
}

fn read_session_messages(path: &Path, limit: Option<usize>) -> Vec<Value> {
    let Some(limit) = limit else { return read_all_session_messages(path) };
    if limit == 0 {
        return Vec::new();
    }
    let Ok(mut file) = File::open(path) else { return Vec::new() };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else { return Vec::new() };
    const CHUNK: u64 = 2 * 1024 * 1024;
    // A preview is a window, not a transcript import. Four megabytes is enough for the
    // normal recent turns and caps memory/parse work even for a multi-gigabyte session.
    const MAX_TAIL: u64 = 4 * 1024 * 1024;
    let mut tail = Vec::new();
    let mut start = length;
    let mut messages = Vec::new();
    while start > 0 && (tail.len() as u64) < MAX_TAIL {
        let size = CHUNK.min(start);
        start -= size;
        if file.seek(SeekFrom::Start(start)).is_err() {
            return Vec::new();
        }
        let mut chunk = vec![0; size as usize];
        if file.read_exact(&mut chunk).is_err() {
            return Vec::new();
        }
        chunk.extend_from_slice(&tail);
        tail = chunk;
        let text = String::from_utf8_lossy(&tail);
        // A chunk boundary can split a JSON line. Drop only that partial first line.
        let usable = if start > 0 { text.split_once('\n').map_or("", |(_, rest)| rest) } else { text.as_ref() };
        messages = usable
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|value| value.get("message").cloned())
            .collect();
        if messages.len() >= limit {
            break;
        }
    }
    if messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }
    messages
}

fn read_all_session_messages(path: &Path) -> Vec<Value> {
    let Ok(file) = File::open(path) else { return Vec::new() };
    let reader = BufReader::new(file.take(32 * 1024 * 1024));
    let mut messages = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(message) = value.get("message") {
                messages.push(message.clone());
            }
        }
    }
    messages
}

#[tauri::command]
pub fn chat_flow_reports(session_path: String) -> Result<Vec<FlowReportRecord>, String> {
    let path = validated_session_path(&session_path)?;
    Ok(read_flow_reports(&path))
}

fn read_flow_reports(path: &Path) -> Vec<FlowReportRecord> {
    let Ok(file) = File::open(path) else { return Vec::new() };
    let reader = BufReader::new(file.take(32 * 1024 * 1024));
    let mut reports = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("type").and_then(Value::as_str) != Some("custom_message") {
            continue;
        }
        if value.get("display").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(custom_type) = value.get("customType").and_then(Value::as_str) else { continue };
        if !custom_type.starts_with("jouzu-flow") {
            continue;
        }
        let Some(content) = value.get("content") else { continue };
        let text = text_from_content(content);
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(kind) = parsed.get("kind").and_then(Value::as_str) else { continue };
        reports.push(FlowReportRecord { kind: kind.to_string(), text });
    }
    if reports.len() > 30 {
        reports.drain(0..reports.len() - 30);
    }
    reports
}

fn normalize_workspace(value: &str) -> String {
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(value)
        .trim_end_matches(['\\', '/'])
        .to_string()
}

fn text_from_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn title_from_content(content: &Value) -> String {
    let cleaned = text_from_content(content).split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = cleaned.chars().take(MAX_TITLE_CHARS).collect::<String>();
    if cleaned.chars().count() > MAX_TITLE_CHARS {
        title.push('…');
    }
    title
}

fn session_header(path: &Path) -> (String, String) {
    let Ok(file) = File::open(path) else {
        return (String::new(), String::new());
    };
    let mut reader = BufReader::new(file.take(MAX_PREFIX_BYTES));
    let mut line = String::new();
    let mut workspace = String::new();
    let mut title = String::new();
    for _ in 0..MAX_LINES {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                    workspace = normalize_workspace(cwd);
                }
            }
            Some("message") => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                if message.get("role").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                let Some(content) = message.get("content") else {
                    continue;
                };
                let candidate = title_from_content(content);
                if !candidate.is_empty() {
                    title = candidate;
                    break;
                }
            }
            _ => {}
        }
    }
    (workspace, title)
}

fn list_sessions(directory: &Path) -> Vec<SessionSummary> {
    list_sessions_with_preferences(directory, &HashMap::new())
}

fn list_sessions_with_preferences(
    directory: &Path,
    preferences: &HashMap<String, SessionPreference>,
) -> Vec<SessionSummary> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let updated = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_secs());
        let (workspace, title) = session_header(&path);
        if title.is_empty() || workspace.is_empty() {
            continue;
        }
        let key = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let preference = preferences.get(&key.to_string_lossy().into_owned());
        sessions.push(SessionSummary {
            path: path.to_string_lossy().into_owned(),
            title: preference
                .and_then(|value| value.title.as_deref())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or(title),
            workspace,
            updated,
            pinned: preference.is_some_and(|value| value.pinned),
            archived: preference.is_some_and(|value| value.archived),
        });
    }
    sessions.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated.cmp(&left.updated))
    });
    sessions.truncate(MAX_SESSIONS);
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(path: &Path, cwd: &str, title: &str) {
        let mut file = File::create(path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"session","version":3,"id":"s","cwd":cwd})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":title}]}})
        )
        .unwrap();
    }

    #[test]
    fn preview_reads_only_a_bounded_tail_of_a_large_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"session","version":3,"id":"s","cwd":"C:/Work"})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"x".repeat(5 * 1024 * 1024)}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"recent"}]}})).unwrap();
        let messages = read_session_messages(&path, Some(200));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"][0]["text"], "recent");
    }

    #[test]
    fn lists_sessions_newest_first_with_titles_and_normalized_workspaces() {
        let directory = tempfile::tempdir().unwrap();
        let older = directory.path().join("older.jsonl");
        let newer = directory.path().join("newer.jsonl");
        write_session(&older, r"\\?\C:\Work\One", "  Fix   the parser  ");
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(&older).unwrap().set_modified(old_time).unwrap();
        write_session(&newer, r"C:\Work\Two", "Add a workspace rail");
        let sessions = list_sessions(directory.path());
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].path, newer.to_string_lossy());
        assert_eq!(sessions[0].workspace, r"C:\Work\Two");
        assert_eq!(sessions[0].title, "Add a workspace rail");
        assert_eq!(sessions[1].path, older.to_string_lossy());
        assert_eq!(sessions[1].workspace, r"C:\Work\One");
        assert_eq!(sessions[1].title, "Fix the parser");
    }

    #[test]
    fn pinned_sessions_sort_first_and_preferences_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let sessions_dir = directory.path().join("state/sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let older = sessions_dir.join("older.jsonl");
        let newer = sessions_dir.join("newer.jsonl");
        write_session(&older, r"C:\Work\One", "Older");
        write_session(&newer, r"C:\Work\Two", "Newer");
        let key = fs::canonicalize(&older).unwrap().to_string_lossy().into_owned();
        let mut preferences = HashMap::new();
        preferences.insert(key, SessionPreference { pinned: true, archived: true, title: None });
        let sessions = list_sessions_with_preferences(&sessions_dir, &preferences);
        assert_eq!(sessions[0].path, older.to_string_lossy());
        assert!(sessions[0].pinned);
        assert!(sessions[0].archived);
        assert!(!sessions[1].pinned);
        write_preferences(directory.path(), &preferences).unwrap();
        let read = read_preferences(directory.path()).unwrap();
        assert!(read.get(&fs::canonicalize(&older).unwrap().to_string_lossy().into_owned()).unwrap().pinned);
    }

    #[test]
    fn reads_only_displayed_flow_reports() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("flow.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"custom_message","customType":"jouzu-flow","display":true,"content":[{"type":"text","text":"{\"kind\":\"work\",\"content\":\"Continue\"}"}]})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"custom_message","customType":"jouzu-flow","content":[{"type":"text","text":format!("{{\"kind\":\"work\",\"content\":\"{}\"}}", "long ".repeat(40))}]})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"custom_message","customType":"jouzu-flow","display":false,"content":[{"type":"text","text":"{\"kind\":\"alert\",\"content\":\"Hidden\"}"}]})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"custom_message","customType":"other","content":[{"type":"text","text":"{\"kind\":\"result\"}"}]})).unwrap();
        let reports = read_flow_reports(&path);
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].kind, "work");
        assert!(reports[0].text.contains("Continue"));
        assert!(reports[1].text.contains("long long"));
    }

    #[test]
    fn derives_model_and_tool_time_from_session_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("timing.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","timestamp":"2026-10-19T15:08:07.000Z","message":{"role":"user","content":[]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","timestamp":"2026-10-19T15:08:08.797Z","message":{"role":"assistant","timestamp":1792422487810_i64,"usage":{"output":96},"content":[{"type":"toolCall","id":"call"}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","timestamp":"2026-10-19T15:08:08.824Z","message":{"role":"toolResult","content":[]}})).unwrap();
        let timing = read_session_timing(&path);
        assert_eq!(timing.turns, 1);
        assert_eq!(timing.steps, 1);
        assert_eq!(timing.output_tokens, 96);
        assert_eq!(timing.model_ms, 987);
        assert_eq!(timing.tool_ms, 27);
    }

    #[test]
    fn reads_session_messages_for_an_instant_preview() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("messages.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"custom_message","customType":"other","content":[]})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}})).unwrap();
        let messages = read_session_messages(&path, None);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
    }

    #[test]
    fn branches_through_the_selected_message() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.jsonl");
        let mut file = File::create(&source).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"session","version":3,"id":"source","cwd":r"C:\Work"})).unwrap();
        for (index, text) in ["first", "first answer", "second", "second answer"].iter().enumerate() {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            writeln!(file, "{}", serde_json::json!({"type":"message","id":format!("m{index}"),"message":{"role":role,"content":[{"type":"text","text":text}]}})).unwrap();
        }
        let target = branch_session_file(&source, 3).unwrap();
        let lines: Vec<Value> = fs::read_to_string(&target).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines[0]["type"], "session");
        assert_eq!(lines[0]["parentSession"], source.to_string_lossy().as_ref());
        assert_eq!(lines[0]["cwd"], r"C:\Work");
        let messages: Vec<&Value> = lines.iter().skip(1).filter(|line| line["type"] == "message").collect();
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[3]["message"]["content"][0]["text"], "second answer");

        let earlier = branch_session_file(&source, 1).unwrap();
        let earlier_messages: Vec<Value> = fs::read_to_string(&earlier).unwrap().lines().skip(1).map(|line| serde_json::from_str(line).unwrap()).filter(|line: &Value| line["type"] == "message").collect();
        assert_eq!(earlier_messages.len(), 2);
        assert_eq!(earlier_messages[1]["message"]["content"][0]["text"], "first answer");
    }

    #[test]
    fn ignores_invalid_and_empty_files() {        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("broken.jsonl"), "not json\n").unwrap();
        std::fs::write(directory.path().join("ignore.txt"), "{}").unwrap();
        std::fs::write(directory.path().join("empty.jsonl"), "{\"type\":\"session\",\"cwd\":\"C:\\\\Empty\"}\n").unwrap();
        assert!(list_sessions(directory.path()).is_empty());
    }
}











