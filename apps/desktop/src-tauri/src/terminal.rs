use std::{path::Path, path::PathBuf};

use crate::tool_script;

const SCRIPT: &str = "terminal-environment.ps1";

/// The Windows Terminal that should host the console: the copy Jouzu ships once it is installed,
/// otherwise the one this PC has. Nothing here means the standard console host.
pub fn host(root: &Path) -> Option<PathBuf> {
    let output = tool_script::run(root, SCRIPT, &[]).ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every run writes the helper first (tool_script), so an empty folder answers with this PC's
    // Windows Terminal when it has one; only a folder where the helper cannot be written has none.
    #[test]
    fn a_folder_without_the_bundled_copy_uses_this_pcs_terminal_or_none() {
        let directory = tempfile::tempdir().unwrap();
        if let Some(path) = host(directory.path()) {
            assert!(path.is_file());
            assert!(!path.starts_with(directory.path()));
        }
    }

    #[test]
    fn a_root_where_the_helper_cannot_be_written_reports_no_host_instead_of_panicking() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-folder");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(host(&file), None);
    }
}
