use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};

const MIN_IMAGE_SIDE: u32 = 16;

/// Repair a session whose history holds an image the provider refuses.
///
/// The host owns the session files, so the repair lives here. The original is kept
/// as `.jsonl.bak` and the rewrite is atomic: a failed repair changes nothing.
pub fn sanitize_images(session_path: &str) -> Result<Value, String> {
    let path = session_file(session_path)?;
    let (removed, backup) = sanitize(&path, MIN_IMAGE_SIDE)?;
    Ok(json!({ "removed": removed, "backup": backup.to_string_lossy() }))
}

fn session_file(session_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(session_path)
        .canonicalize()
        .map_err(|_| "That session is not available.".to_string())?;
    if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("That session is not available.".to_string());
    }
    Ok(path)
}

/// Pixel size from the container header, or None when this format's header does not
/// carry it. Guessing here would delete images that are fine.
fn image_size(mime: Option<&str>, data: &str) -> Option<(u32, u32)> {
    let bytes = BASE64.decode(data).ok()?;
    match mime.unwrap_or("") {
        "image/png" if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" => Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        )),
        "image/gif" if bytes.len() >= 10 => Some((
            u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
            u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
        )),
        "image/jpeg" => {
            let mut offset = 2;
            while offset + 9 < bytes.len() {
                if bytes[offset] != 0xFF {
                    offset += 1;
                    continue;
                }
                let marker = bytes[offset + 1];
                let frame = matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF);
                if frame {
                    let height =
                        u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?) as u32;
                    let width =
                        u16::from_be_bytes(bytes[offset + 7..offset + 9].try_into().ok()?) as u32;
                    return Some((width, height));
                }
                let length =
                    u16::from_be_bytes(bytes[offset + 2..offset + 4].try_into().ok()?) as usize;
                if length < 2 {
                    return None;
                }
                offset += 2 + length;
            }
            None
        }
        _ => None,
    }
}

/// Replace images the provider would refuse with a text placeholder.
fn sanitize(path: &Path, min_side: u32) -> Result<(usize, PathBuf), String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut removed = 0usize;
    let mut output = String::with_capacity(text.len());
    for line in text.lines() {
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            output.push_str(line);
            output.push('\n');
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(content) = value
                .get_mut("message")
                .and_then(|message| message.get_mut("content"))
                .and_then(Value::as_array_mut)
            {
                for block in content.iter_mut() {
                    if block.get("type").and_then(Value::as_str) != Some("image") {
                        continue;
                    }
                    let mime = block.get("mimeType").and_then(Value::as_str);
                    let Some((width, height)) = block
                        .get("data")
                        .and_then(Value::as_str)
                        .and_then(|data| image_size(mime, data))
                    else {
                        continue;
                    };
                    if width.min(height) >= min_side {
                        continue;
                    }
                    *block = json!({
                        "type": "text",
                        "text": format!("[image removed: {width}\u{00d7}{height}px is below the model's minimum of {min_side}px]")
                    });
                    removed += 1;
                }
            }
        }
        output.push_str(&serde_json::to_string(&value).map_err(|error| error.to_string())?);
        output.push('\n');
    }
    if removed == 0 {
        return Ok((0, path.to_path_buf()));
    }
    let backup = path.with_extension("jsonl.bak");
    std::fs::copy(path, &backup).map_err(|error| error.to_string())?;
    let staged = path.with_extension("jsonl.tmp");
    std::fs::write(&staged, output).map_err(|error| error.to_string())?;
    std::fs::rename(&staged, path).map_err(|error| error.to_string())?;
    Ok((removed, backup))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_png() -> String {
        // 8x8 PNG header: below the 16px minimum.
        let mut bytes = vec![0u8; 33];
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&8u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&8u32.to_be_bytes());
        BASE64.encode(bytes)
    }

    #[test]
    fn a_small_image_becomes_a_placeholder_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = json!({
            "type": "message",
            "message": { "role": "user", "content": [
                { "type": "image", "mimeType": "image/png", "data": tiny_png() }
            ]}
        });
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let (removed, backup) = sanitize(&path, MIN_IMAGE_SIDE).unwrap();

        assert_eq!(removed, 1);
        assert!(backup.is_file());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[image removed: 8"));
        assert!(!text.contains("\"type\":\"image\""));
    }

    #[test]
    fn a_large_image_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = vec![0u8; 33];
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&64u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&64u32.to_be_bytes());
        let line = json!({
            "type": "message",
            "message": { "role": "user", "content": [
                { "type": "image", "mimeType": "image/png", "data": BASE64.encode(bytes) }
            ]}
        });
        std::fs::write(&path, format!("{line}\n")).unwrap();

        assert_eq!(sanitize(&path, MIN_IMAGE_SIDE).unwrap().0, 0);
    }
}