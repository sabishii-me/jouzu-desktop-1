use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::Manager;

pub struct HostProcess(pub Mutex<Option<Child>>);

pub fn start(app: &tauri::AppHandle) -> Result<String, String> {
    let managed = crate::runtime::managed_root()?;
    let runtime_home = crate::runtime::effective_home()?;
    let dist = dist_dir()?;
    let binary = host_binary(app)?;
    let info_path = managed.join("host.json");
    // A previous host may have left discovery behind. Never navigate to that
    // stale port while the new host is starting.
    let _ = std::fs::remove_file(&info_path);
    let mut child = Command::new(&binary)
        .arg("--dist")
        .arg(&dist)
        .arg("--home")
        .arg(&managed)
        .arg("--runtime-home")
        .arg(&runtime_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start the host: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("The host did not publish host.json in time".into());
        }
        if let Ok(text) = std::fs::read_to_string(&info_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let port = value.get("port").and_then(Value::as_u64);
                let token = value.get("token").and_then(Value::as_str);
                if let (Some(port), Some(token)) = (port, token) {
                    app.manage(HostProcess(Mutex::new(Some(child))));
                    return Ok(format!("http://127.0.0.1:{port}/?token={token}"));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<HostProcess>() {
        let mut child = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn dist_dir() -> Result<PathBuf, String> {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if dev.join("index.html").is_file() {
        return Ok(dev);
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let beside = current
        .parent()
        .ok_or("Executable has no directory")?
        .join("dist");
    if beside.join("index.html").is_file() {
        return Ok(beside);
    }
    Err("Could not find the built UI directory".into())
}

fn host_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("JOUZU_HOST_BIN") {
        if Path::new(&value).is_file() {
            return Ok(PathBuf::from(value));
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../host/target/debug/jouzu-host.exe");
    if dev.is_file() {
        return Ok(dev);
    }
    if let Ok(resource) = app.path().resource_dir() {
        let packaged = resource.join("host/jouzu-host.exe");
        if packaged.is_file() {
            return Ok(packaged);
        }
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            let beside = parent.join("jouzu-host.exe");
            if beside.is_file() {
                return Ok(beside);
            }
        }
    }
    Err("Could not find jouzu-host.exe".into())
}
