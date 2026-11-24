//! The window starts the host with `--exit-with-stdin` and keeps the pipe open for its
//! lifetime. When the window ends in any way, the pipe closes and the host must stop on
//! its own, releasing the lock, so the next start is not refused (#183).
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn the_host_stops_and_releases_its_home_when_stdin_closes() {
    let root = tempfile::tempdir().unwrap();
    let dist = root.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let home = root.path().join("home");
    let start = |extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_jouzu-host"))
            .arg("--dist")
            .arg(&dist)
            .arg("--home")
            .arg(&home)
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };

    let mut host = start(&["--exit-with-stdin"]);
    let mut ready = String::new();
    BufReader::new(host.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert!(ready.contains("\"ready\""), "{ready}");
    assert!(home.join("host.json").is_file());

    // The window is gone: its end of the pipe closes.
    drop(host.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = host.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "the host kept running after stdin closed");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "{status}");
    assert!(!home.join("host.json").exists());
    assert!(!home.join("host.lock").exists());

    // Without the flag, a closed stdin means nothing: the host keeps serving.
    let mut next = start(&[]);
    let mut ready = String::new();
    BufReader::new(next.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert!(ready.contains("\"ready\""), "the next start was refused: {ready}");
    drop(next.stdin.take());
    std::thread::sleep(Duration::from_millis(500));
    assert!(next.try_wait().unwrap().is_none(), "the host stopped without the flag");
    let _ = next.kill();
    let _ = next.wait();
}
