//! One-time import of the Launcher data into the Desktop data root.
//!
//! The source tree is read-only. Existing Desktop files win, so a retry or a
//! partially completed migration cannot overwrite newer data.

use std::fs;
use std::path::{Path, PathBuf};

const MARKER_DIRECTORY: &str = "migration";
const MARKER_FILE: &str = "launcher-data-v1.json";

pub fn migrate_legacy_launcher_data() -> Result<(), String> {
    #[cfg(not(windows))]
    return Ok(());
    #[cfg(debug_assertions)]
    if std::env::var_os("JOUZU_LAUNCHER_DEV_HOME").is_some() {
        return Ok(());
    }
    if std::env::var_os("JOUZU_HOME").is_some_and(|value| !value.is_empty()) {
        return Ok(());
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    let root = PathBuf::from(local).join("Shisa.ai");
    let source = root.join("Jouzu");
    let destination = root.join("JouzuDesktop");
    migrate(&source, &destination)
}

/// Import Launcher `data/` and `recent.json` once.
///
/// The marker lives outside `data/`: deleting Desktop data intentionally does
/// not import Launcher data again on the next start.
pub fn migrate(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination || !source.is_dir() {
        return Ok(());
    }
    let marker = destination.join(MARKER_DIRECTORY).join(MARKER_FILE);
    if marker.is_file() {
        return Ok(());
    }
    fs::create_dir_all(destination).map_err(|error| format!("Cannot create Desktop data root: {error}"))?;
    copy_missing(&source.join("data"), &destination.join("data"))?;
    copy_file(&source.join("recent.json"), &destination.join("recent.json"))?;
    let marker_directory = destination.join(MARKER_DIRECTORY);
    fs::create_dir_all(&marker_directory).map_err(|error| format!("Cannot create migration marker directory: {error}"))?;
    let record = serde_json::json!({
        "schemaVersion": 1,
        "source": source.to_string_lossy(),
        "imported": ["data", "recent.json"],
    });
    let temporary = marker_directory.join(format!("{MARKER_FILE}.tmp-{}", std::process::id()));
    fs::write(&temporary, format!("{record}\n")).map_err(|error| format!("Cannot write migration marker: {error}"))?;
    fs::rename(&temporary, &marker).map_err(|error| format!("Cannot publish migration marker: {error}"))?;
    Ok(())
}

fn copy_missing(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot inspect {}: {error}", source.display())),
    };
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("Cannot create {}: {error}", destination.display()))?;
        for entry in fs::read_dir(source).map_err(|error| format!("Cannot read {}: {error}", source.display()))? {
            let entry = entry.map_err(|error| format!("Cannot read {}: {error}", source.display()))?;
            copy_missing(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        copy_file(source, destination)
    } else {
        Ok(())
    }
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_file() || destination.exists() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| format!("Cannot copy {} to {}: {error}", source.display(), destination.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn imports_missing_files_once_without_overwriting_desktop_data() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Jouzu");
        let destination = root.path().join("JouzuDesktop");
        fs::create_dir_all(source.join("data/state/sessions")).unwrap();
        fs::write(source.join("data/state/sessions/old.jsonl"), "old").unwrap();
        fs::write(source.join("data/settings.json"), "legacy").unwrap();
        fs::write(source.join("recent.json"), "legacy recent").unwrap();
        fs::create_dir_all(destination.join("data")).unwrap();
        fs::write(destination.join("data/settings.json"), "new").unwrap();

        migrate(&source, &destination).unwrap();

        assert_eq!(fs::read_to_string(destination.join("data/state/sessions/old.jsonl")).unwrap(), "old");
        assert_eq!(fs::read_to_string(destination.join("data/settings.json")).unwrap(), "new");
        assert_eq!(fs::read_to_string(destination.join("recent.json")).unwrap(), "legacy recent");
        assert!(destination.join("migration/launcher-data-v1.json").is_file());

        fs::write(source.join("data/state/sessions/old.jsonl"), "changed").unwrap();
        migrate(&source, &destination).unwrap();
        assert_eq!(fs::read_to_string(destination.join("data/state/sessions/old.jsonl")).unwrap(), "old");
    }

    #[test]
    fn missing_launcher_data_is_a_noop() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Jouzu");
        let destination = root.path().join("JouzuDesktop");
        migrate(&source, &destination).unwrap();
        assert!(!destination.exists());
    }

    #[cfg(windows)]
    #[test]
    fn skips_symlinked_entries() {
        use std::os::windows::fs::symlink_file;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Jouzu");
        let destination = root.path().join("JouzuDesktop");
        fs::create_dir_all(source.join("data")).unwrap();
        fs::write(root.path().join("outside"), "outside").unwrap();
        if symlink_file(root.path().join("outside"), source.join("data/link")).is_err() {
            return;
        }
        migrate(&source, &destination).unwrap();
        assert!(!destination.join("data/link").exists());
    }
}
