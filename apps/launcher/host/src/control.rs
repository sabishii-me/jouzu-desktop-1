use serde_json::Value;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// Jouzu's private configuration adapter. The host owns its execution; the shell
/// no longer runs configuration code.
const CONTROL: &str = include_str!("../../../../packaging/launcher/control.mjs");

pub struct ControlManager {
    root: PathBuf,
    home: PathBuf,
    node: PathBuf,
    app: PathBuf,
    active: AtomicBool,
}

struct Guard<'a>(&'a AtomicBool);

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ControlManager {
    pub fn new(root: PathBuf, home: PathBuf) -> Self {
        let node = root.join("runtime").join("node").join("node.exe");
        let app = resolve_app(&root);
        Self {
            root,
            home,
            node,
            app,
            active: AtomicBool::new(false),
        }
    }

    pub fn paths(&self) -> (PathBuf, PathBuf) {
        (self.node.clone(), self.app.clone())
    }

    pub fn request(&self, request: Value) -> Result<Value, String> {
        if self
            .active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Another configuration operation is running".into());
        }
        let _guard = Guard(&self.active);
        if !self.node.is_file() {
            return Err(format!("Configuration Node is unavailable: {}", self.node.display()));
        }
        if !self.app.join("bootstrap.mjs").is_file() {
            return Err(format!("Configuration app is unavailable: {}", self.app.display()));
        }

        let mut child = Command::new(&self.node);
        child
            .arg("--input-type=module")
            .arg("--eval")
            .arg(CONTROL)
            .arg("--")
            .arg(&self.root)
            .arg(&self.app)
            .env("JOUZU_HOME", &self.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x08000000);
        }
        let mut child = child
            .spawn()
            .map_err(|_| "Cannot start configuration service".to_string())?;
        child
            .stdin
            .take()
            .ok_or("Configuration input unavailable")?
            .write_all(
                &serde_json::to_vec(&request)
                    .map_err(|error| format!("Invalid configuration request: {error}"))?,
            )
            .map_err(|_| "Cannot send configuration request".to_string())?;

        let started = Instant::now();
        loop {
            if child
                .try_wait()
                .map_err(|_| "Cannot check configuration operation".to_string())?
                .is_some()
            {
                break;
            }
            if started.elapsed() > Duration::from_secs(190) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Configuration operation timed out; retry it".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(mut pipe) = child.stdout.take() {
            pipe.read_to_end(&mut stdout)
                .map_err(|_| "Configuration output failed".to_string())?;
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_end(&mut stderr);
        }
        let status = child
            .wait()
            .map_err(|_| "Configuration service failed".to_string())?;
        let result: Value = serde_json::from_slice(&stdout)
            .map_err(|_| "Invalid configuration service response".to_string())?;
        if !status.success() {
            return Err(result["error"]
                .as_str()
                .unwrap_or("Configuration operation failed")
                .to_string());
        }
        Ok(result)
    }
}

fn resolve_app(root: &Path) -> PathBuf {
    let bundled = root.join("app");
    if bundled.join("bootstrap.mjs").is_file() {
        return bundled;
    }
    let receipt = root.join("updates").join("active.json");
    let Ok(bytes) = std::fs::read(&receipt) else {
        return bundled;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return bundled;
    };
    let Some(slot) = value["slot"].as_str() else {
        return bundled;
    };
    if slot.is_empty()
        || slot.len() > 100
        || !slot
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return bundled;
    }
    let selected = root
        .join("updates")
        .join("versions")
        .join(slot)
        .join("app");
    if selected.join("bootstrap.mjs").is_file() {
        selected
    } else {
        bundled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_slot_wins_when_present() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("updates/versions/test-slot/app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("bootstrap.mjs"), "fixture").unwrap();
        std::fs::write(
            root.path().join("updates/active.json"),
            r#"{"schemaVersion":1,"slot":"test-slot","version":"0.1.18"}"#,
        )
        .unwrap();
        assert_eq!(resolve_app(root.path()), app);
    }

    #[test]
    fn invalid_slot_does_not_escape() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("updates/active.json"),
            r#"{"schemaVersion":1,"slot":"../escape","version":"0.1.18"}"#,
        )
        .unwrap();
        assert_eq!(resolve_app(root.path()), root.path().join("app"));
    }
}
