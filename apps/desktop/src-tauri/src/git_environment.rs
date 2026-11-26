use std::path::{Path, PathBuf};

/// Runs the Git Bash helper through the shared runner.
#[cfg(windows)]
fn helper_with(root: &Path, arguments: &[String]) -> Result<std::process::Output, String> {
    crate::tool_script::run(root, "git-environment.ps1", arguments)
}

/// The bash to launch Jouzu with. On Windows it comes from the managed helper, which
/// never silently uses a system Git; elsewhere the platform's own bash is the runtime.
pub fn find(root: &Path) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        let _ = root;
        for candidate in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"] {
            let path = PathBuf::from(candidate);
            if path.is_file() && std::process::Command::new(&path).args(["-lc", "exit 0"]).status().map(|status| status.success()).unwrap_or(false) {
                return Ok(path);
            }
        }
        return Err("Bash is unavailable. Install it to run Jouzu.".into());
    }
    #[cfg(windows)]
    {
        let output = helper_with(root, &[])?;
        if !output.status.success() {
            return Err(crate::tool_script::failure(&output, "Git Bash is unavailable. Install it in Settings → System."));
        }
        let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if !path.is_file() {
            return Err("Git Bash detection returned an invalid path".into());
        }
        Ok(path)
    }
}
