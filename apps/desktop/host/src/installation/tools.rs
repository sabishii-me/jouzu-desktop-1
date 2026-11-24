//! The Windows tools of the installation: Jouzu's Git Bash and its Windows
//! Terminal. Each is managed by a PowerShell helper this build carries, which
//! owns every Windows detail of its component (which copies are usable, their
//! versions, and how an archive is verified before it is extracted).
//!
//! macOS and Linux use the platform's own bash and terminal; there is nothing to
//! install there.

use std::path::Path;
#[cfg(windows)]
use std::{
    path::PathBuf,
    process::{Command, Output},
};

#[cfg(windows)]
const GIT: &str = "git-environment.ps1";
#[cfg(windows)]
const TERMINAL: &str = "terminal-environment.ps1";

/// The helpers this host runs. They are written before each run, so an updated
/// app never runs a helper an older version left behind. A file that already
/// holds the same text is left alone, so the window's console never sees a
/// helper rewritten under it.
#[cfg(windows)]
const SCRIPTS: [(&str, &str); 3] = [
    (GIT, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/git-environment.ps1"))),
    ("extract-portable-git.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extract-portable-git.ps1"))),
    (TERMINAL, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/terminal-environment.ps1"))),
];

/// Jouzu's own Git Bash, not just its folder: a reinstall over an older version
/// runs the old uninstaller, which deletes `installed` but leaves the archive and
/// the folder behind (#158). Elsewhere the system bash is used.
pub fn git_present(managed: &Path) -> bool {
    !cfg!(windows) || managed.join("runtime/git/installed/bin/bash.exe").is_file()
}

#[cfg(windows)]
fn write_scripts(managed: &Path) -> Result<PathBuf, String> {
    let directory = managed.join("runtime").join("desktop-tools");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for (name, body) in SCRIPTS {
        let path = directory.join(name);
        if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
            std::fs::write(&path, body).map_err(|error| error.to_string())?;
        }
    }
    Ok(directory)
}

#[cfg(windows)]
fn run(managed: &Path, script: &str, arguments: &[&str]) -> Result<Output, String> {
    let directory = write_scripts(managed)?;
    let windows = std::env::var_os("SystemRoot").ok_or("Windows directory unavailable")?;
    let mut command =
        Command::new(PathBuf::from(windows).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    // Windows PowerShell must resolve its own modules; a host started from
    // PowerShell 7 carries a module path where its Security module fails to load.
    command.env_remove("PSModulePath");
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(directory.join(script))
        .arg("-InstallRoot")
        .arg(managed)
        .args(arguments);
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.output().map_err(|_| "Cannot run a desktop helper".to_string())
}

/// PowerShell puts the message the script printed first, and its own frames after it.
#[cfg(windows)]
fn failure(output: &Output, fallback: &str) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    text.lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("At ")
                && !line.starts_with('+')
                && !line.starts_with("CategoryInfo")
                && !line.starts_with("FullyQualifiedErrorId")
        })
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(windows)]
fn printed_path(output: &Output, message: &str) -> Result<PathBuf, String> {
    if !output.status.success() {
        return Err(failure(output, message));
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if !path.is_file() {
        return Err(message.to_string());
    }
    Ok(path)
}

/// Installs Jouzu's Git Bash: the bundled archive when it is present, otherwise
/// the pinned git-for-windows release, verified by digest and publisher.
#[cfg(windows)]
pub fn install_git(managed: &Path) -> Result<PathBuf, String> {
    printed_path(&run(managed, GIT, &["-Install"])?, "Git Bash installation failed")
}

/// Installs the bundled Windows Terminal, verified by digest before extraction.
#[cfg(windows)]
pub fn install_terminal(managed: &Path) -> Result<PathBuf, String> {
    printed_path(&run(managed, TERMINAL, &["-Install"])?, "Windows Terminal installation failed")
}

/// What Settings shows for each tool: which copies exist and which one is used,
/// as the helper reports it. `null` for a tool whose state cannot be read.
#[cfg(windows)]
pub fn report(managed: &Path) -> serde_json::Value {
    let read = |script: &str| -> serde_json::Value {
        run(managed, script, &["-Report"])
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
            .unwrap_or(serde_json::Value::Null)
    };
    let mut git = read(GIT);
    if git.is_object() {
        // Jouzu's own copies first, then the one this PC has.
        git["effective"] = if !git["bundled"].is_null() {
            git["bundled"].clone()
        } else if !git["managed"].is_null() {
            git["managed"].clone()
        } else {
            git["system"].clone()
        };
    }
    serde_json::json!({ "git": git, "terminal": read(TERMINAL) })
}

/// Nothing to report where the platform's own tools are used.
#[cfg(not(windows))]
pub fn report(_managed: &Path) -> serde_json::Value {
    serde_json::Value::Null
}
