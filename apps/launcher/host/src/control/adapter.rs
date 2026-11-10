//! The control adapter: how the private Jouzu script is handed to Node, and how the
//! lines it writes are read. Two functions and no trait: the manager calls them
//! directly, and a future file- or command-based adapter changes only these bodies.

use std::path::PathBuf;

/// The private Jouzu configuration adapter, embedded so it cannot drift from the
/// binary that runs it. Windows rejects a command line above 32,767 characters, so
/// the script must stay well under it; `MAX_SCRIPT_BYTES` trips loudly instead of
/// failing at spawn time.
pub const SCRIPT: &str = include_str!("../../../../../packaging/launcher/control.mjs");
pub const MAX_SCRIPT_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone)]
pub struct ControlContext {
    pub node: PathBuf,
    /// Managed root passed as the adapter's first argument.
    pub root: PathBuf,
    /// The active Jouzu app passed as the adapter's second argument.
    pub app: PathBuf,
    pub home: PathBuf,
    /// Saved environment entries, applied after `JOUZU_HOME`.
    pub environment: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A device-code notice from the adapter. It is written to stderr as one JSON line
/// during Shisa.AI sign-in or a provider OAuth flow; nothing else on stderr is an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub url: String,
    pub code: String,
}

pub fn spec(context: &ControlContext) -> Result<LaunchSpec, String> {
    if SCRIPT.len() > MAX_SCRIPT_BYTES {
        return Err("Control adapter is too large for the command line".into());
    }
    // Node rejects verbatim paths, so the managed paths are converted at this boundary.
    let root = super::app::process_path(&context.root);
    let app = super::app::process_path(&context.app);
    let args = vec![
        "--input-type=module".to_string(),
        "--eval".to_string(),
        SCRIPT.to_string(),
        "--".to_string(),
        root.to_string_lossy().into_owned(),
        app.to_string_lossy().into_owned(),
    ];
    let mut env = vec![(
        "JOUZU_HOME".to_string(),
        context.home.to_string_lossy().into_owned(),
    )];
    env.extend(context.environment.iter().cloned());
    Ok(LaunchSpec {
        program: super::app::process_path(&context.node),
        args,
        env,
    })
}

/// Parse one stderr line. The adapter writes `{"type":"device","url":…,"code":…}`;
/// every other line (logs, blank lines, malformed JSON) is not an event.
pub fn parse_event(line: &str) -> Option<DeviceCode> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|value| value.as_str()) != Some("device") {
        return None;
    }
    let url = value.get("url").and_then(|value| value.as_str())?.trim();
    let code = value.get("code").and_then(|value| value.as_str())?.trim();
    if url.is_empty() || code.is_empty() || url.len() > 2048 || code.len() > 128 {
        return None;
    }
    Some(DeviceCode {
        url: url.to_string(),
        code: code.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ControlContext {
        ControlContext {
            node: PathBuf::from(r"C:\managed\runtime\node\node.exe"),
            root: PathBuf::from(r"C:\managed"),
            app: PathBuf::from(r"C:\managed\app"),
            home: PathBuf::from(r"C:\managed\data"),
            environment: vec![("EXAMPLE".into(), "1".into())],
        }
    }

    #[test]
    fn the_script_fits_the_command_line() {
        assert!(SCRIPT.len() <= MAX_SCRIPT_BYTES, "adapter grew to {} bytes", SCRIPT.len());
        assert!(spec(&context()).is_ok());
    }

    #[test]
    fn the_spec_passes_root_and_app_positionally() {
        let spec = spec(&context()).unwrap();
        assert!(spec.program.ends_with("node.exe"));
        assert_eq!(spec.args[0], "--input-type=module");
        assert_eq!(spec.args[1], "--eval");
        assert_eq!(spec.args[2], SCRIPT);
        assert_eq!(spec.args[3], "--");
        assert_eq!(spec.args[4], r"C:\managed");
        assert_eq!(spec.args[5], r"C:\managed\app");
        assert_eq!(spec.args.len(), 6);
    }

    #[test]
    fn the_spec_sets_jouzu_home_before_saved_environment() {
        let spec = spec(&context()).unwrap();
        assert_eq!(spec.env[0], ("JOUZU_HOME".to_string(), r"C:\managed\data".to_string()));
        assert_eq!(spec.env[1], ("EXAMPLE".to_string(), "1".to_string()));
    }

    #[test]
    fn a_device_line_becomes_an_event() {
        // The exact shape `control.mjs` writes to stderr.
        let line = r#"{"type":"device","url":"https://example.test/activate","code":"ABCD-EFGH"}"#;
        let code = parse_event(line).expect("device line");
        assert_eq!(code.url, "https://example.test/activate");
        assert_eq!(code.code, "ABCD-EFGH");
    }

    #[test]
    fn other_lines_are_not_events() {
        for line in [
            "",
            "   ",
            "starting configuration",
            "{\"type\":\"progress\",\"value\":1}",
            "{\"type\":\"device\"}",
            "{\"type\":\"device\",\"url\":\"\",\"code\":\"X\"}",
            "{\"type\":\"device\",\"url\":\"https://example.test\",\"code\":\"\"}",
            "{\"type\":\"device\",\"url\":\"https://example.test\",\"code\":1}",
            "not json at all",
        ] {
            assert_eq!(parse_event(line), None, "unexpected event for {line:?}");
        }
    }
}
