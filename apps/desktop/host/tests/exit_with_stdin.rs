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

struct Host {
    child: std::process::Child,
    port: u16,
    token: String,
}

fn start_window_host(dist: &std::path::Path, home: &std::path::Path) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_jouzu-host"))
        .arg("--dist")
        .arg(dist)
        .arg("--home")
        .arg(home)
        .arg("--exit-with-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn ready(mut child: std::process::Child) -> Host {
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
    Host {
        port: value["port"].as_u64().unwrap_or_else(|| panic!("not ready: {line}")) as u16,
        token: value["token"].as_str().unwrap().to_string(),
        child,
    }
}

fn dist_in(root: &std::path::Path) -> std::path::PathBuf {
    let dist = root.join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    dist
}

fn wait_for_exit(child: &mut std::process::Child, what: &str) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A normal quit closes the pipe while the window still has its event stream open. The
/// host must not wait for that stream to end: it ends it and stops.
#[test]
fn the_host_stops_with_an_event_stream_still_open() {
    use std::io::{Read, Write};
    let root = tempfile::tempdir().unwrap();
    let dist = dist_in(root.path());
    let home = root.path().join("home");
    let mut host = ready(start_window_host(&dist, &home));

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", host.port)).unwrap();
    write!(
        stream,
        "GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\n\r\n",
        host.port, host.token
    )
    .unwrap();
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).unwrap();
    assert_eq!(&head, b"HTTP/1.1 200", "{}", String::from_utf8_lossy(&head));

    drop(host.child.stdin.take());
    let status = wait_for_exit(&mut host.child, "the host waited for the open event stream");
    assert!(status.success(), "{status}");
    assert!(!home.join("host.json").exists());
    assert!(!home.join("host.lock").exists());
}

/// Reopening the app right after a Force Quit: the new window's host waits for the previous
/// one, which stops when its pipe closes, and then starts normally.
#[cfg(not(windows))]
#[test]
fn a_new_window_host_starts_once_the_previous_one_has_stopped() {
    let root = tempfile::tempdir().unwrap();
    let dist = dist_in(root.path());
    let home = root.path().join("home");
    let mut previous = ready(start_window_host(&dist, &home));

    let next = start_window_host(&dist, &home);
    let (started, wait) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let host = ready(next);
        let _ = started.send(());
        host
    });
    assert!(
        wait.recv_timeout(Duration::from_millis(500)).is_err(),
        "a second host started while the first held the home"
    );

    // The previous window is gone.
    drop(previous.child.stdin.take());
    wait_for_exit(&mut previous.child, "the previous host kept running");
    let mut next = reader.join().unwrap();
    assert!(home.join("host.json").is_file());

    drop(next.child.stdin.take());
    assert!(wait_for_exit(&mut next.child, "the next host kept running").success());
}
