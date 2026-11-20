//! "Mark commits made by the agent" (Settings > Environment, off by default).
//!
//! When it is on, every runtime starts with git configuration in its environment
//! (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) that points
//! `core.hooksPath` at hooks this module writes into the data home. Only git
//! started by the agent sees it: the person's own terminals and git config files
//! are untouched. Each of those hooks runs the repository's own hook of the same
//! name first, unchanged; `prepare-commit-msg` then adds [`TRAILER`].
//!
//! Like Claude Code's attribution, the trailer names the model and a second
//! trailer names the session: each runtime gets a file of its own
//! (`JOUZU_GIT_ATTRIBUTION`) where the session it serves writes its id and its
//! current model ([`describe`]); the hook reads it at commit time, so a warm
//! runtime taken by a session and a model picked mid-session are both right.
//!
//! It marks commits, it does not prove who made them: git started with a cleared
//! environment or its own `core.hooksPath` skips it.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The line as the setting shows it; commits carry the model in parentheses
/// after the name and a `Jouzu-Session:` line when the session is known.
pub const TRAILER: &str = "Co-authored-by: Jouzu Desktop (<model>) <noreply@shisa.ai>";
pub const SESSION_TRAILER: &str = "Jouzu-Session: <session id>";

const FILE_VARIABLE: &str = "JOUZU_GIT_ATTRIBUTION";

const HOOK: &str = include_str!("git_hooks/hook.sh");

/// Every hook git runs from a hooks folder, so a repository's own hooks keep
/// running while ours is the folder git uses.
const HOOKS: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "post-index-change",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
];

#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize)]
pub struct Setting {
    pub enabled: bool,
}

fn path(home: &Path) -> PathBuf {
    home.join("commit-attribution.json")
}

fn hooks_dir(home: &Path) -> PathBuf {
    home.join("git-hooks")
}

fn runs_dir(home: &Path) -> PathBuf {
    hooks_dir(home).join("runs")
}

/// A name no other runtime of this host or an earlier one uses.
fn run_name() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{}-{now:x}-{next}", std::process::id())
}

/// The file a runtime started with `env` reads its attribution from, if any.
pub fn runtime_file(env: &[(OsString, OsString)]) -> Option<PathBuf> {
    env.iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(FILE_VARIABLE))
        .map(|(_, value)| PathBuf::from(value))
}

/// Write which session a runtime serves and its model, for the hooks. A model
/// is named by its name, else its id; `<`, `>` and line breaks are dropped so
/// the line stays one valid trailer.
pub fn describe(file: &Path, session: &str, model: Option<&serde_json::Value>) {
    let label = model
        .and_then(|model| model.get("name").or_else(|| model.get("id")))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let clean = |text: &str| text.chars().filter(|c| !matches!(c, '<' | '>' | '\n' | '\r')).collect::<String>();
    let temp = file.with_extension("tmp");
    if std::fs::write(&temp, format!("session={}\nmodel={}\n", clean(session), clean(label).trim())).is_ok() {
        let _ = std::fs::rename(&temp, file);
    }
}

/// The saved choice; nothing saved is off.
pub fn read(home: &Path) -> Result<Setting, String> {
    match std::fs::read(path(home)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid commit attribution setting".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Setting::default()),
        Err(_) => Err("Cannot read the commit attribution setting".into()),
    }
}

pub fn save(home: &Path, setting: Setting) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|_| "Cannot create settings directory")?;
    let target = path(home);
    let temp = target.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&setting).map_err(|_| "Cannot encode the commit attribution setting")?;
    std::fs::write(&temp, bytes).map_err(|_| "Cannot save the commit attribution setting")?;
    std::fs::rename(&temp, &target).map_err(|_| "Cannot replace the commit attribution setting".to_string())
}

/// Write the hooks as this build ships them; a file already right is left alone.
fn install(home: &Path) -> Result<PathBuf, String> {
    let dir = hooks_dir(home);
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot create the git hooks folder")?;
    for name in HOOKS {
        let file = dir.join(name);
        if std::fs::read(&file).is_ok_and(|bytes| bytes == HOOK.as_bytes()) {
            continue;
        }
        let temp = dir.join(format!(".{name}.tmp"));
        std::fs::write(&temp, HOOK).map_err(|_| "Cannot write the git hooks")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
                .map_err(|_| "Cannot make the git hooks executable")?;
        }
        std::fs::rename(&temp, &file).map_err(|_| "Cannot replace the git hooks")?;
    }
    Ok(dir)
}

/// The variables a runtime starts with for the saved choice, added after the
/// git configuration already in `environment` (keyed by upper-case name). Off
/// adds nothing.
pub fn variables(
    home: &Path,
    environment: &HashMap<String, (OsString, OsString)>,
) -> Result<Vec<(String, OsString)>, String> {
    if !read(home)?.enabled {
        return Ok(Vec::new());
    }
    let dir = install(home)?;
    std::fs::create_dir_all(runs_dir(home)).map_err(|_| "Cannot create the git hooks folder")?;
    let index = environment
        .get("GIT_CONFIG_COUNT")
        .and_then(|(_, value)| value.to_str())
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    Ok(vec![
        (format!("GIT_CONFIG_KEY_{index}"), OsString::from("core.hooksPath")),
        (format!("GIT_CONFIG_VALUE_{index}"), dir.into_os_string()),
        ("GIT_CONFIG_COUNT".into(), OsString::from((index + 1).to_string())),
        // The hooks find the repository's own hooks folder by switching this
        // entry off for one git call.
        ("JOUZU_GIT_HOOKS_INDEX".into(), OsString::from(index.to_string())),
        (FILE_VARIABLE.into(), runs_dir(home).join(run_name()).into_os_string()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_saved_is_off_and_adds_nothing() {
        let home = tempfile::tempdir().unwrap();
        assert!(!read(home.path()).unwrap().enabled);
        assert!(variables(home.path(), &HashMap::new()).unwrap().is_empty());
        assert!(!hooks_dir(home.path()).exists());
    }

    #[test]
    fn on_appends_after_existing_git_configuration() {
        let home = tempfile::tempdir().unwrap();
        save(home.path(), Setting { enabled: true }).unwrap();
        let mut environment = HashMap::new();
        environment.insert("GIT_CONFIG_COUNT".to_string(), (OsString::from("GIT_CONFIG_COUNT"), OsString::from("3")));
        let variables = variables(home.path(), &environment).unwrap();
        let get = |name: &str| variables.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone());
        assert_eq!(get("GIT_CONFIG_KEY_3"), Some(OsString::from("core.hooksPath")));
        assert_eq!(get("GIT_CONFIG_VALUE_3"), Some(hooks_dir(home.path()).into_os_string()));
        assert_eq!(get("GIT_CONFIG_COUNT"), Some(OsString::from("4")));
        assert_eq!(get("JOUZU_GIT_HOOKS_INDEX"), Some(OsString::from("3")));
        let file = PathBuf::from(get("JOUZU_GIT_ATTRIBUTION").unwrap());
        assert_eq!(file.parent(), Some(runs_dir(home.path()).as_path()));
        assert!(file.parent().unwrap().is_dir());
        for name in HOOKS {
            assert_eq!(std::fs::read_to_string(hooks_dir(home.path()).join(name)).unwrap(), HOOK);
        }
    }

    /// Runs real git (skipped where there is none on PATH). On Windows this is
    /// Git for Windows, which runs the hooks with its own `sh`.
    #[test]
    fn git_commits_get_the_trailer_and_repository_hooks_still_run() {
        use std::process::Command;
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        save(home.path(), Setting { enabled: true }).unwrap();
        let repo = tempfile::tempdir().unwrap();
        let mut base = HashMap::new();
        base.insert("GIT_CONFIG_COUNT".to_string(), (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")));
        let mut env = variables(home.path(), &base).unwrap();
        // One configuration entry the person already had (index 0).
        env.push(("GIT_CONFIG_KEY_0".into(), "commit.gpgsign".into()));
        env.push(("GIT_CONFIG_VALUE_0".into(), "false".into()));
        for (key, value) in [
            ("GIT_AUTHOR_NAME", "a"),
            ("GIT_AUTHOR_EMAIL", "a@example.com"),
            ("GIT_COMMITTER_NAME", "a"),
            ("GIT_COMMITTER_EMAIL", "a@example.com"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ] {
            env.push((key.into(), value.into()));
        }
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .env_remove("GIT_CONFIG_PARAMETERS")
                .envs(env.iter().map(|(key, value)| (key, value)))
                .output()
                .unwrap();
            (output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
        };
        let message = || git(&["log", "-1", "--format=%B"]).1;
        assert!(git(&["init", "-q", "-b", "main"]).0);

        assert!(git(&["commit", "-q", "--allow-empty", "-m", "first"]).0);
        // No session took this runtime yet: the name alone.
        const PLAIN: &str = "Co-authored-by: Jouzu Desktop <noreply@shisa.ai>";
        assert_eq!(message().trim_end(), format!("first\n\n{PLAIN}"));

        // A session with a model: both trailers. Amending after a model change
        // keeps one set, the current one.
        let file = runtime_file(&env.iter().map(|(key, value)| (OsString::from(key), value.clone())).collect::<Vec<_>>()).unwrap();
        describe(&file, "s-1", Some(&serde_json::json!({ "id": "m-1", "name": "Model <One>" })));
        assert!(git(&["commit", "-q", "--amend", "--allow-empty", "-m", "first again"]).0);
        assert_eq!(
            message().trim_end(),
            "first again\n\nCo-authored-by: Jouzu Desktop (Model One) <noreply@shisa.ai>\nJouzu-Session: s-1"
        );
        describe(&file, "s-1", Some(&serde_json::json!({ "id": "m-2" })));
        assert!(git(&["commit", "-q", "--amend", "--allow-empty", "--no-edit"]).0);
        assert_eq!(
            message().trim_end(),
            "first again\n\nCo-authored-by: Jouzu Desktop (m-2) <noreply@shisa.ai>\nJouzu-Session: s-1"
        );
        std::fs::remove_file(&file).unwrap();

        // Another agent's trailer stays and ours is added once.
        let other = "Co-authored-by: Someone <someone@example.com>";
        assert!(git(&["commit", "-q", "--allow-empty", "-m", &format!("both\n\n{other}")]).0);
        assert_eq!(message().trim_end(), format!("both\n\n{other}\n{PLAIN}"));

        // An empty message still aborts.
        let (ok, _, _) = Command::new("git")
            .args(["commit", "-q", "--allow-empty"])
            .current_dir(repo.path())
            .env("GIT_EDITOR", "true")
            .envs(env.iter().map(|(key, value)| (key, value)))
            .output()
            .map(|output| (output.status.success(), (), ()))
            .unwrap();
        assert!(!ok);

        // The repository's own hooks folder still runs and can still refuse.
        let own = repo.path().join(".hooks");
        std::fs::create_dir_all(&own).unwrap();
        let refuse = own.join("commit-msg");
        std::fs::write(&refuse, "#!/bin/sh\ngrep -q BLOCK \"$1\" && exit 1\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&refuse, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(git(&["config", "core.hooksPath", ".hooks"]).0);
        assert!(!git(&["commit", "-q", "--allow-empty", "-m", "BLOCK this"]).0);
        assert!(git(&["commit", "-q", "--allow-empty", "-m", "allowed"]).0);
        assert_eq!(message().trim_end(), format!("allowed\n\n{PLAIN}"));

        // A commit copied by cherry-pick keeps its message.
        assert!(git(&["checkout", "-q", "-b", "side"]).0);
        let plain: Vec<(String, OsString)> = env.iter().filter(|(key, _)| !key.starts_with("GIT_CONFIG_") && key != "JOUZU_GIT_HOOKS_INDEX").cloned().collect();
        let status = Command::new("git")
            .args(["commit", "-q", "--allow-empty", "-m", "by a person"])
            .current_dir(repo.path())
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .envs(plain.iter().map(|(key, value)| (key, value)))
            .status()
            .unwrap();
        assert!(status.success());
        assert!(git(&["checkout", "-q", "main"]).0);
        assert!(git(&["cherry-pick", "--allow-empty", "side"]).0);
        assert_eq!(message().trim_end(), "by a person");
    }
}
