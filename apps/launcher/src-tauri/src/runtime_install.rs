use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// The runtime is the official npm package, installed from the official registry.
const NODE_VERSION: &str = "24.22.1";
const NODE_BASE: &str = "https://nodejs.org/dist";
const LOCKFILE: &str = "4.1.2";
const MAX_ARCHIVE: u64 = 192 * 1024 * 1024;
const MAX_TEXT: u64 = 2 * 1024 * 1024;
const BOOTSTRAP: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/launcher/bootstrap.mjs"
));
const CONTROL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/launcher/control.mjs"
));
const GIT_ENVIRONMENT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/launcher/git-environment.ps1"
));
const GIT_EXTRACT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/launcher/extract-portable-git.ps1"
));
const TERMINAL_ENVIRONMENT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/launcher/terminal-environment.ps1"
));
const APP_MANIFEST: &str = "{\n  \"name\": \"jouzu-desktop-runtime\",\n  \"private\": true\n}\n";

type Progress<'a> = &'a dyn Fn(serde_json::Value);

fn http(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| format!("Could not start the download: {error}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("Could not download {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {} for {url}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {url}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{url} is larger than the allowed size."));
    }
    Ok(bytes)
}

/// A download that reports its byte count, so the prepare screen has a real bar.
fn http_stream(url: &str, limit: u64, phase: &str, progress: Progress) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| format!("Could not start the download: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("Could not download {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {} for {url}", response.status()));
    }
    let total = response.content_length();
    let mut bytes = Vec::new();
    let mut downloaded = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    let mut reported = 0u64;
    progress(serde_json::json!({ "phase": phase, "downloaded": 0, "total": total }));
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {url}: {error}"))?;
        if read == 0 {
            break;
        }
        downloaded += read as u64;
        if downloaded > limit {
            return Err(format!("{url} is larger than the allowed size."));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if downloaded - reported >= 256 * 1024 {
            reported = downloaded;
            progress(serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }));
        }
    }
    progress(serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }));
    Ok(bytes)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn archive_name() -> String {
    format!("node-v{NODE_VERSION}-win-x64.zip")
}

fn digest_for(shasums: &str, name: &str) -> Option<String> {
    shasums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let digest = parts.next()?;
        let file = parts.next()?;
        (file == name && digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| digest.to_ascii_lowercase())
    })
}

fn tar_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("tar.exe")
}

fn extract(archive: &Path, directory: &Path) -> Result<(), String> {
    let status = Command::new(tar_exe())
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(directory)
        .status()
        .map_err(|error| format!("Could not start the extractor: {error}"))?;
    if !status.success() {
        return Err("The downloaded archive could not be extracted.".into());
    }
    Ok(())
}

/// Node is the one thing the npm package cannot bring itself.
fn version_matches(actual: &str) -> bool {
    actual.trim() == format!("v{NODE_VERSION}")
}

/// Whether the managed Node is the pinned, patched build.
pub fn node_version_ok(root: &Path) -> bool {
    let executable = root.join("runtime").join("node").join("node.exe");
    if !executable.is_file() {
        return false;
    }
    std::process::Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .map(|output| version_matches(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or(false)
}

fn ensure_node(managed: &Path, progress: Progress) -> Result<PathBuf, String> {
    let node = managed.join("runtime").join("node");
    let executable = node.join("node.exe");
    if executable.is_file() {
        if node_version_ok(managed) {
            return Ok(executable);
        }
        // A runtime provisioned by an older build keeps its Node; replace it so a
        // security release is not left behind.
        std::fs::remove_dir_all(&node).map_err(|error| format!("Could not replace the old Node runtime: {error}"))?;
    }
    let name = archive_name();
    let shasums = http(&format!("{NODE_BASE}/v{NODE_VERSION}/SHASUMS256.txt"), MAX_TEXT)?;
    let text = String::from_utf8(shasums).map_err(|_| "The Node checksum file is not text.")?;
    let expected = digest_for(&text, &name).ok_or("The Node checksum file does not list this build.")?;
    let bytes = http_stream(&format!("{NODE_BASE}/v{NODE_VERSION}/{name}"), MAX_ARCHIVE, "node", progress)?;
    if sha256(&bytes) != expected {
        return Err("The Node download does not match its published checksum.".into());
    }
    let staging = managed.join("install-node.tmp");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let archive = staging.join(&name);
    std::fs::write(&archive, &bytes).map_err(|error| error.to_string())?;
    extract(&archive, &staging)?;
    let extracted = std::fs::read_dir(&staging)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("node-v")))
        .ok_or("The Node archive did not contain a runtime folder.")?;
    std::fs::create_dir_all(node.parent().unwrap()).map_err(|error| error.to_string())?;
    std::fs::rename(&extracted, &node).map_err(|error| format!("Could not install Node: {error}"))?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(executable)
}

/// npm lifecycle scripts invoke `node` by name. On a clean machine the Node we
/// just unpacked is not on the user's PATH, and npm does not add it for the
/// scripts it spawns, so the installer child gets the same PATH the runtime
/// bootstrap gives a session: the bundled Node first, then the app's shims.
fn installer_path(node: &Path, app: &Path) -> Result<std::ffi::OsString, String> {
    let node_directory = node.parent().ok_or("The Node executable has no directory.")?;
    let mut paths = vec![
        node_directory.to_path_buf(),
        app.join("node_modules").join(".bin"),
    ];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(paths)
        .map_err(|error| format!("Could not prepare the package installer environment: {error}"))
}

fn npm_install(node: &Path, app: &Path, progress: Progress) -> Result<(), String> {
    let npm = node
        .parent()
        .unwrap()
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if !npm.is_file() {
        return Err("The Node package does not carry npm.".into());
    }
    std::fs::create_dir_all(app).map_err(|error| error.to_string())?;
    if !app.join("package.json").is_file() {
        std::fs::write(app.join("package.json"), APP_MANIFEST).map_err(|error| error.to_string())?;
    }
    progress(serde_json::json!({ "phase": "packages" }));
    let path = installer_path(node, app)?;
    let output = Command::new(node)
        .arg(&npm)
        .arg("install")
        .arg("jouzu@latest")
        .arg(format!("proper-lockfile@{LOCKFILE}"))
        .arg("--omit=dev")
        .arg("--no-audit")
        .arg("--no-fund")
        .env("PATH", path)
        .current_dir(app)
        .output()
        .map_err(|_| "Could not start the package installation.".to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        return Err(if detail.is_empty() {
            "The official package could not be installed.".to_string()
        } else {
            format!("The official package could not be installed: {detail}")
        });
    }
    // The package ships its patched dependencies nested; the desktop's control
    // service loads them from the app's node_modules, as the prepared prefix does.
    flatten(&app.join("node_modules"))?;
    Ok(())
}

fn flatten(node_modules: &Path) -> Result<(), String> {
    let nested = node_modules.join("jouzu").join("node_modules");
    if !nested.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&nested).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if name == ".bin" {
            continue;
        }
        let target = node_modules.join(&name);
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            if target.exists() {
                std::fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
            }
            std::fs::rename(entry.path(), &target).map_err(|error| format!("Could not lay out the runtime packages: {error}"))?;
        } else if kind.is_file() && !target.exists() {
            std::fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn installed_version(app: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(app.join("node_modules/jouzu/package.json"))
        .map_err(|_| "The installed package is missing its metadata.")?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "The installed package metadata is invalid.")?;
    value
        .get("version")
        .and_then(|item| item.as_str())
        .map(str::to_string)
        .ok_or_else(|| "The installed package has no version.".to_string())
}

fn check_health(managed: &Path, node: &Path) -> Result<(), String> {
    let bootstrap = managed.join("app").join("bootstrap.mjs");
    let home = managed.join("data");
    std::fs::create_dir_all(&home).map_err(|error| error.to_string())?;
    let output = Command::new(node)
        .arg(&bootstrap)
        .arg("--version")
        .env("JOUZU_HOME", &home)
        .env("JOUZU_NO_UPDATE", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .output()
        .map_err(|_| "The installed runtime did not start.".to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        return Err(if detail.is_empty() {
            "The installed runtime did not start.".to_string()
        } else {
            format!("The installed runtime did not start: {detail}")
        });
    }
    Ok(())
}

/// The setup service is what onboarding talks to next, so it must answer.
fn check_control(managed: &Path, node: &Path) -> Result<(), String> {
    let mut child = Command::new(node)
        .arg("--input-type=module")
        .arg("--eval")
        .arg(CONTROL)
        .arg("--")
        .arg(managed)
        .arg(managed.join("app"))
        .env("JOUZU_HOME", managed.join("data"))
        .env("JOUZU_NO_UPDATE", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "The installed runtime did not answer the setup service.".to_string())?;
    child
        .stdin
        .take()
        .ok_or("The setup service did not accept its request.")?
        .write_all(br#"{"action":"status"}"#)
        .map_err(|_| "The setup service did not accept its request.".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "The setup service did not answer.".to_string())?;
    if !output.status.success() {
        return Err("The installed runtime did not answer the setup service.".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The setup service answered in an unknown form.".to_string())?;
    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
        return Err(format!("The installed runtime cannot read its configuration: {error}"));
    }
    Ok(())
}

/// Install Node and the official npm package, refusing to touch a working install.
fn install_runtime(managed: &Path, progress: Progress) -> Result<String, String> {
    let app = managed.join("app");
    if app.join("bootstrap.mjs").is_file() {
        return Err("A runtime is already installed. Update it instead.".into());
    }
    // A previous failed attempt may have left the app directory without an entry script.
    if app.exists() {
        std::fs::remove_dir_all(&app).map_err(|error| format!("Could not clear the previous attempt: {error}"))?;
    }
    let node = ensure_node(managed, progress)?;
    npm_install(&node, &app, progress)?;
    progress(serde_json::json!({ "phase": "verify" }));
    std::fs::write(app.join("bootstrap.mjs"), BOOTSTRAP).map_err(|error| error.to_string())?;
    let version = installed_version(&app)?;
    if let Err(error) = check_health(managed, &node).and_then(|_| check_control(managed, &node)) {
        let _ = std::fs::remove_dir_all(&app);
        return Err(error);
    }
    Ok(version)
}

/// Install Node, the official npm package and the tools the workspace needs.
pub fn install(managed: &Path, progress: Progress) -> Result<String, String> {
    // The app may already be installed while its Node is old; replace Node first.
    ensure_node(managed, progress)?;
    let app = managed.join("app");
    // A retry after a tool failure must not touch a runtime that is already there.
    let version = if app.join("bootstrap.mjs").is_file() {
        installed_version(&app)?
    } else {
        install_runtime(managed, progress)?
    };
    write_tool_scripts(managed)?;
    install_tools(managed, progress)?;
    crate::image_tool::ensure(managed)?;
    Ok(version)
}

/// The tool components are part of the same install, not a menu.
fn install_tools(managed: &Path, progress: Progress) -> Result<(), String> {
    progress(serde_json::json!({ "phase": "tools", "tool": "git" }));
    crate::git_environment::install(managed)?;
    progress(serde_json::json!({ "phase": "tools", "tool": "terminal" }));
    crate::terminal::install(managed)?;
    Ok(())
}

/// These helpers are the desktop's own; the npm package does not carry them.
fn write_tool_scripts(managed: &Path) -> Result<(), String> {
    let directory = managed.join("runtime").join("launcher-update");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for (name, body) in [
        ("git-environment.ps1", GIT_ENVIRONMENT),
        ("extract-portable-git.ps1", GIT_EXTRACT),
        ("terminal-environment.ps1", TERMINAL_ENVIRONMENT),
    ] {
        std::fs::write(directory.join(name), body).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_pinned_node_version_is_accepted() {
        assert!(version_matches(&format!("v{NODE_VERSION}")));
        assert!(!version_matches("v24.19.0"));
        assert!(!version_matches(""));
    }

    #[test]
    fn a_shasums_file_names_the_build_it_pins() {
        let text = "abc  other.zip\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  node-v24.22.1-win-x64.zip\n";
        assert_eq!(
            digest_for(text, "node-v24.22.1-win-x64.zip").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert_eq!(digest_for(text, "missing.zip"), None);
    }

    #[test]
    fn the_package_installer_puts_the_bundled_node_before_the_existing_path() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("runtime/node/node.exe");
        let app = root.path().join("app");
        let path = installer_path(&node, &app).unwrap();
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries[0], node.parent().unwrap());
        assert_eq!(entries[1], app.join("node_modules/.bin"));
    }

    #[test]
    fn a_working_install_is_never_replaced() {
        let managed = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(managed.path().join("app")).unwrap();
        std::fs::write(managed.path().join("app/bootstrap.mjs"), b"existing").unwrap();
        let error = install_runtime(managed.path(), &|_| {}).unwrap_err();
        assert!(error.contains("already installed"), "{error}");
        assert_eq!(std::fs::read(managed.path().join("app/bootstrap.mjs")).unwrap(), b"existing");
    }

    /// The real thing: Node from nodejs.org and jouzu from the official npm registry.
    #[test]
    #[ignore]
    fn installs_the_official_runtime() {
        let managed = tempfile::tempdir().unwrap();
        let version = install_runtime(managed.path(), &|_| {}).unwrap();
        assert!(managed.path().join("runtime/node/node.exe").is_file());
        assert!(managed.path().join("app/bootstrap.mjs").is_file());
        assert!(managed.path().join("app/node_modules/jouzu/package.json").is_file());
        assert!(!version.is_empty(), "the installed package version is reported");
    }
}
