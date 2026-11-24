//! The runtime installation, owned by the host (ADR 0026).
//!
//! The desktop release carries no runtime (ADR 0003): Node, the Jouzu package
//! and, on Windows, Git Bash and Windows Terminal are installed into the data
//! home. This module is the only code that decides whether that installation is
//! there and current, and the only code that installs, updates or repairs it.
//! Its state is one value, published in `AppView.installation`; clients render
//! it and ask for an operation through `POST /v1/runtime/{action}`.
//!
//! States: `absent`, `installing` (step and real progress), `update-required`,
//! `ready` (versions) or `failed` (typed code). The host checks the installation
//! when it starts and installs or updates it on its own. While it is not
//! `ready`, sessions are refused with `runtime-not-ready`.

pub mod extensions;
pub mod policy;
pub mod runtime;
pub mod tools;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde_json::{json, Value};

/// What is on disk.
#[derive(Clone, Debug, PartialEq)]
pub enum Found {
    /// No usable app (nothing yet, or a first install that did not finish).
    Absent,
    /// An app is there, but it, its Node or a required tool is not what this
    /// build needs.
    Outdated { version: Option<String> },
    Current { version: String, node_version: Option<String> },
}

/// Which operation a client asked for. `update` and `install` do the same work:
/// both bring the installation to what this build pins. `repair` also replaces
/// the installed packages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Update,
    Repair,
}

impl Action {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "install" => Some(Self::Install),
            "update" => Some(Self::Update),
            "repair" => Some(Self::Repair),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Update => "update",
            Self::Repair => "repair",
        }
    }
}

/// The installation work itself. The host uses [`Managed`]; tests use a fake.
pub trait Installer: Send + Sync + 'static {
    /// What is on disk now. Must not change anything.
    fn inspect(&self) -> Found;
    /// Whether the files a session starts from are still there. Cheap: called
    /// on every session start.
    fn files_present(&self) -> bool;
    /// Whether the tools the runtime uses (Jouzu's Git Bash on Windows) are
    /// still there. Cheap, like [`Installer::files_present`].
    fn tools_present(&self) -> bool {
        true
    }
    /// Hold the runtime's files for an operation that replaces them: a terminal
    /// Jouzu holds a shared lease on them while it runs. `None` when there is
    /// nothing to hold.
    fn hold(&self) -> Result<Option<Box<dyn std::any::Any + Send>>, String> {
        Ok(None)
    }
    /// Bring the installation to what this build pins. Blocking.
    fn install(&self, action: Action, progress: &dyn Fn(Value)) -> Result<String, String>;
    /// What a `ready` installation refreshes at each host start (the desktop's
    /// own extensions, which belong to this build).
    fn refresh(&self) -> Result<(), String> {
        Ok(())
    }
    /// The tools' own reports for Settings (Windows); `null` elsewhere. May be slow.
    fn tools(&self) -> Value {
        Value::Null
    }
}

/// The real installation under the host home.
pub struct Managed {
    /// Where Node, the app and the tools live (the host home).
    pub root: PathBuf,
    /// Jouzu's data home, where the desktop's extensions go.
    pub runtime_home: PathBuf,
}

impl Installer for Managed {
    fn inspect(&self) -> Found {
        let Some(version) = runtime::app_version(&self.root) else {
            return Found::Absent;
        };
        if policy::is_mandatory(&version)
            || !runtime::node_whole(&self.root)
            || !tools::git_present(&self.root)
        {
            return Found::Outdated { version: Some(version) };
        }
        Found::Current { version, node_version: runtime::node_version(&self.root) }
    }

    fn files_present(&self) -> bool {
        runtime::node_executable(&self.root).is_file()
            && self.root.join("app").join("bootstrap.mjs").is_file()
    }

    fn tools_present(&self) -> bool {
        tools::git_present(&self.root)
    }

    fn hold(&self) -> Result<Option<Box<dyn std::any::Any + Send>>, String> {
        // A Jouzu started from a terminal (`jz`) runs from these files too and
        // holds a shared lease on them while it runs. With no files, nothing
        // runs from them.
        if !self.files_present() {
            return Ok(None);
        }
        Ok(Some(Box::new(lease(&self.root)?)))
    }

    fn install(&self, action: Action, progress: &dyn Fn(Value)) -> Result<String, String> {
        if action == Action::Repair {
            // The packages are installed again; Node and the tools are checked
            // and replaced only when they are not what this build pins.
            let app = self.root.join("app");
            if app.exists() {
                std::fs::remove_dir_all(&app)
                    .map_err(|error| format!("Could not remove the installed packages: {error}"))?;
            }
        }
        runtime::install(&self.root, &self.runtime_home, progress)
    }

    fn refresh(&self) -> Result<(), String> {
        extensions::ensure(&self.runtime_home)
    }

    fn tools(&self) -> Value {
        tools::report(&self.root)
    }
}

/// The exclusive side of the lease a terminal Jouzu holds while it runs
/// (`updates/sessions.lock`, shared by the console). The system releases it when
/// the handle closes, including after a crash.
fn lease(root: &Path) -> Result<std::fs::File, String> {
    const BUSY: &str = "Jouzu is running in a terminal. Close it, then try again.";
    let directory = root.join("updates");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("sessions.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(&path).map_err(|_| BUSY.to_string())?;
    #[cfg(not(windows))]
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(BUSY.into()),
        Err(std::fs::TryLockError::Error(error)) => return Err(error.to_string()),
    }
    Ok(file)
}

#[derive(Clone, Debug, PartialEq)]
enum State {
    Absent,
    Installing { action: Action, progress: Value },
    UpdateRequired { version: Option<String> },
    Ready { version: String, node_version: Option<String> },
    Failed { action: Action, message: String },
}

impl State {
    fn from_found(found: Found) -> Self {
        match found {
            Found::Absent => Self::Absent,
            Found::Outdated { version } => Self::UpdateRequired { version },
            Found::Current { version, node_version } => Self::Ready { version, node_version },
        }
    }
}

struct Inner {
    state: State,
    tools: Value,
    /// An operation on a `ready` installation that replaces none of the
    /// runtime's files (installing a missing tool): the state stays `ready`,
    /// sessions keep running, and this says what runs.
    operation: Option<(Action, Value)>,
    /// How the last such operation failed; the installation is still `ready`.
    error: Option<(Action, String)>,
}

type Hook = Box<dyn Fn() + Send + Sync>;

pub struct Installation {
    installer: Box<dyn Installer>,
    inner: Mutex<Inner>,
    log_home: Option<PathBuf>,
    /// Called on every change (the host publishes `AppView`).
    on_change: OnceLock<Hook>,
    /// Called when the installation becomes `ready` (the host starts its warm runtime).
    on_ready: OnceLock<Hook>,
    /// Called before files are replaced (the host stops its runtimes, which
    /// would otherwise keep the old files open).
    before_replace: OnceLock<Hook>,
}

/// The code a failed operation carries; its reason is in `params.message`.
pub const FAILED: &str = "runtime-install-failed";

impl Installation {
    /// Checks what is on disk now. Nothing is installed until [`Self::begin`].
    pub fn new(installer: impl Installer, log_home: Option<PathBuf>) -> Arc<Self> {
        let state = State::from_found(installer.inspect());
        Arc::new(Self {
            installer: Box::new(installer),
            inner: Mutex::new(Inner { state, tools: Value::Null, operation: None, error: None }),
            log_home,
            on_change: OnceLock::new(),
            on_ready: OnceLock::new(),
            before_replace: OnceLock::new(),
        })
    }

    /// The installation under `root` (the host home) for Jouzu's `runtime_home`.
    pub fn managed(root: &Path, runtime_home: &Path) -> Arc<Self> {
        Self::new(
            Managed { root: root.to_path_buf(), runtime_home: runtime_home.to_path_buf() },
            Some(root.to_path_buf()),
        )
    }

    pub fn on_change(&self, hook: impl Fn() + Send + Sync + 'static) {
        let _ = self.on_change.set(Box::new(hook));
    }

    pub fn on_ready(&self, hook: impl Fn() + Send + Sync + 'static) {
        let _ = self.on_ready.set(Box::new(hook));
    }

    pub fn before_replace(&self, hook: impl Fn() + Send + Sync + 'static) {
        let _ = self.before_replace.set(Box::new(hook));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn changed(&self) {
        if let Some(hook) = self.on_change.get() {
            hook();
        }
    }

    fn log(&self, level: &str, event: &str, fields: Value) {
        if let Some(home) = &self.log_home {
            crate::log(home, level, event, fields);
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.lock().state, State::Ready { .. })
    }

    /// Start-up: a `ready` installation refreshes what belongs to this build;
    /// any other starts installing at once. No client has to ask.
    pub fn begin(self: &Arc<Self>) {
        let ready = self.is_ready();
        if ready {
            let installation = self.clone();
            std::thread::spawn(move || {
                if let Err(message) = installation.installer.refresh() {
                    installation.log("warn", "installation.refresh", json!({ "error": message }));
                }
                installation.read_tools();
            });
        } else {
            self.start(Action::Install);
        }
    }

    fn read_tools(&self) {
        let tools = self.installer.tools();
        let changed = {
            let mut inner = self.lock();
            let changed = inner.tools != tools;
            inner.tools = tools;
            changed
        };
        if changed {
            self.changed();
        }
    }

    /// Start an operation. Answers whether it started: asking while one runs
    /// changes nothing.
    ///
    /// On a `ready` installation, `install` and `update` replace nothing that
    /// runs (the runtime is what this build pins; what is missing is a tool):
    /// the state stays `ready` and sessions keep running. Anything else
    /// replaces runtime files: the state is `installing` and runtimes stop.
    pub fn start(self: &Arc<Self>, action: Action) -> bool {
        let (previous, light) = {
            let inner = self.lock();
            if matches!(inner.state, State::Installing { .. }) || inner.operation.is_some() {
                return false;
            }
            let light = matches!(inner.state, State::Ready { .. }) && action != Action::Repair;
            (inner.state.clone(), light)
        };
        // Files a terminal Jouzu runs from are not replaced under it, and what
        // runs here is stopped only once they can be: a refused operation
        // changes nothing that runs.
        let hold = if light {
            None
        } else {
            match self.installer.hold() {
                Ok(hold) => hold,
                Err(message) => {
                    self.log("warn", "installation.held", json!({ "action": action.name(), "error": message }));
                    {
                        let mut inner = self.lock();
                        if matches!(inner.state, State::Ready { .. }) {
                            inner.error = Some((action, message));
                        } else {
                            inner.state = State::Failed { action, message };
                        }
                    }
                    self.changed();
                    return true;
                }
            }
        };
        {
            let mut inner = self.lock();
            inner.error = None;
            if light {
                inner.operation = Some((action, json!({ "step": "prepare" })));
            } else {
                inner.state = State::Installing { action, progress: json!({ "step": "prepare" }) };
            }
        }
        self.log("info", "installation.start", json!({ "action": action.name(), "from": view_state(&previous), "replaces": !light }));
        self.changed();
        let installation = self.clone();
        std::thread::spawn(move || installation.run(action, light, hold));
        true
    }

    fn run(self: &Arc<Self>, action: Action, light: bool, hold: Option<Box<dyn std::any::Any + Send>>) {
        // Whatever runs from the installation holds its files open (on Windows
        // they cannot be replaced then); with nothing running this does nothing.
        if !light {
            if let Some(hook) = self.before_replace.get() {
                hook();
            }
        }
        let progress = |value: Value| {
            let step = match value.get("phase").and_then(Value::as_str) {
                Some(phase) => phase.to_string(),
                None => return,
            };
            let mut shown = json!({ "step": step });
            for key in ["downloaded", "total", "tool"] {
                if let Some(item) = value.get(key).filter(|item| !item.is_null()) {
                    shown[key] = item.clone();
                }
            }
            {
                let mut inner = self.lock();
                let current = match (&mut inner.state, light) {
                    (State::Installing { progress, .. }, false) => progress,
                    _ => match &mut inner.operation {
                        Some((_, progress)) => progress,
                        None => return,
                    },
                };
                if *current == shown {
                    return;
                }
                *current = shown;
            }
            self.changed();
        };
        // An installer that panics must not leave the state `installing` forever.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.installer.install(action, &progress)
        }))
        .unwrap_or_else(|_| Err("The installation stopped unexpectedly.".to_string()));
        drop(hold);
        let found = self.installer.inspect();
        let current = matches!(found, Found::Current { .. });
        let (state, error) = match (outcome, found) {
            (Ok(_), found @ Found::Current { .. }) => (State::from_found(found), None),
            // A tool could not be installed; the runtime still runs.
            (Err(message), found @ Found::Current { .. }) if light => (State::from_found(found), Some((action, message))),
            (Ok(version), found) => (
                State::Failed {
                    action,
                    message: format!("The installation finished but is not usable ({version}, {found:?})."),
                },
                None,
            ),
            (Err(message), _) => (State::Failed { action, message }, None),
        };
        // A light operation started on a running installation: nothing was
        // stopped, so nothing has to start again.
        let ready = current && !light;
        match (&state, &error) {
            (State::Failed { message, .. }, _) | (_, Some((_, message))) => {
                self.log("error", "installation.failed", json!({ "action": action.name(), "error": message }))
            }
            (state, None) => self.log("info", "installation.done", json!({ "action": action.name(), "state": view_state(state) })),
        }
        {
            let mut inner = self.lock();
            inner.state = state;
            inner.operation = None;
            inner.error = error;
        }
        self.changed();
        if ready {
            if let Some(hook) = self.on_ready.get() {
                hook();
            }
        }
        self.read_tools();
    }

    /// A session is about to start. When the runtime's files disappeared while
    /// the host runs, the installation is `absent` again and is installed again
    /// on its own, instead of asking the person to repair it. Answers whether
    /// the installation is `ready`.
    pub fn verify(self: &Arc<Self>) -> bool {
        if !self.is_ready() {
            return false;
        }
        if self.installer.files_present() {
            if !self.installer.tools_present() {
                self.tool_lost();
            }
            return true;
        }
        let found = self.installer.inspect();
        self.log("warn", "installation.lost", json!({ "found": format!("{found:?}") }));
        {
            let mut inner = self.lock();
            if !matches!(inner.state, State::Ready { .. }) {
                return false;
            }
            inner.state = State::from_found(found);
        }
        self.changed();
        if self.is_ready() {
            return true;
        }
        self.start(Action::Install);
        false
    }

    /// A tool the runtime uses disappeared while the host runs (#158): Settings
    /// shows it missing, and it is installed again on its own, beside running
    /// sessions, as the runtime's own files are. One that could not be
    /// installed is left to the person (Settings shows why) instead of being
    /// tried again at every check.
    fn tool_lost(self: &Arc<Self>) {
        {
            let inner = self.lock();
            if inner.operation.is_some() || inner.error.is_some() {
                return;
            }
        }
        self.log("warn", "installation.tool_lost", json!({}));
        self.read_tools();
        self.start(Action::Install);
    }

    /// `AppView.installation`.
    pub fn view(&self) -> Value {
        let inner = self.lock();
        let mut value = json!({ "state": view_state(&inner.state), "tools": inner.tools });
        match &inner.state {
            State::Absent => {}
            State::Installing { action, progress } => {
                value["action"] = json!(action.name());
                if let Some(fields) = progress.as_object() {
                    for (key, item) in fields {
                        value[key] = item.clone();
                    }
                }
            }
            State::UpdateRequired { version } => {
                value["version"] = json!(version);
                value["expectedVersion"] = json!(runtime::expected_version());
            }
            State::Ready { version, node_version } => {
                value["version"] = json!(version);
                value["nodeVersion"] = json!(node_version);
                value["expectedVersion"] = json!(runtime::expected_version());
                if let Some((action, progress)) = &inner.operation {
                    let mut operation = json!({ "action": action.name() });
                    if let Some(fields) = progress.as_object() {
                        for (key, item) in fields {
                            operation[key] = item.clone();
                        }
                    }
                    value["operation"] = operation;
                }
                if let Some((action, message)) = &inner.error {
                    value["action"] = json!(action.name());
                    value["error"] = json!({ "code": FAILED, "params": { "message": message } });
                }
            }
            State::Failed { action, message } => {
                value["action"] = json!(action.name());
                value["error"] = json!({ "code": FAILED, "params": { "message": message } });
            }
        }
        value
    }

    /// The refusal of a session start while the installation is not `ready`.
    pub fn not_ready(&self) -> crate::session::ApiError {
        let mut error = crate::session::ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "runtime-not-ready",
            "Jouzu's runtime is not installed yet.",
            false,
        );
        error.details = Some(json!({ "installation": self.view() }));
        error
    }
}

fn view_state(state: &State) -> &'static str {
    match state {
        State::Absent => "absent",
        State::Installing { .. } => "installing",
        State::UpdateRequired { .. } => "update-required",
        State::Ready { .. } => "ready",
        State::Failed { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// An installation whose disk is a few flags.
    #[derive(Default)]
    struct Fake {
        installed: AtomicBool,
        outdated: AtomicBool,
        files: AtomicBool,
        fail: AtomicBool,
        /// A tool the runtime uses is gone.
        tool_lost: AtomicBool,
        /// A terminal Jouzu holds the files.
        held: AtomicBool,
        installs: AtomicUsize,
        repairs: AtomicUsize,
        /// Held while installing, so a test can look at the `installing` state.
        gate: Mutex<()>,
    }

    impl Installer for Arc<Fake> {
        fn inspect(&self) -> Found {
            if !self.installed.load(Ordering::SeqCst) {
                Found::Absent
            } else if self.outdated.load(Ordering::SeqCst) {
                Found::Outdated { version: Some("0.2.4".into()) }
            } else {
                Found::Current { version: "0.2.5".into(), node_version: Some("v24.22.2".into()) }
            }
        }
        fn files_present(&self) -> bool {
            self.files.load(Ordering::SeqCst)
        }
        fn tools_present(&self) -> bool {
            !self.tool_lost.load(Ordering::SeqCst)
        }
        fn hold(&self) -> Result<Option<Box<dyn std::any::Any + Send>>, String> {
            if self.held.load(Ordering::SeqCst) {
                return Err("Jouzu is running in a terminal. Close it, then try again.".into());
            }
            Ok(None)
        }
        fn install(&self, action: Action, progress: &dyn Fn(Value)) -> Result<String, String> {
            progress(json!({ "phase": "node", "downloaded": 10, "total": 100 }));
            let _gate = self.gate.lock().unwrap();
            self.installs.fetch_add(1, Ordering::SeqCst);
            if action == Action::Repair {
                self.repairs.fetch_add(1, Ordering::SeqCst);
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("Could not download https://nodejs.org/dist: offline".into());
            }
            self.installed.store(true, Ordering::SeqCst);
            self.outdated.store(false, Ordering::SeqCst);
            self.files.store(true, Ordering::SeqCst);
            self.tool_lost.store(false, Ordering::SeqCst);
            Ok("0.2.5".into())
        }
    }

    fn settle(installation: &Installation) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let view = installation.view();
            if view["state"] != "installing" {
                return view;
            }
            assert!(Instant::now() < deadline, "the installation did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn counted(installation: &Installation) -> (Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let (changes, ready, stops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let counter = changes.clone();
        installation.on_change(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let counter = ready.clone();
        installation.on_ready(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let counter = stops.clone();
        installation.before_replace(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        (changes, ready, stops)
    }

    #[test]
    fn a_first_start_installs_on_its_own_and_becomes_ready() {
        let fake = Arc::new(Fake::default());
        let installation = Installation::new(fake.clone(), None);
        assert_eq!(installation.view()["state"], "absent");
        let (changes, ready, stops) = counted(&installation);
        let gate = fake.gate.lock().unwrap();
        installation.begin();
        let view = installation.view();
        assert_eq!(view["state"], "installing");
        assert_eq!(view["action"], "install");
        drop(gate);
        let view = settle(&installation);
        assert_eq!(view["state"], "ready", "{view}");
        assert_eq!(view["version"], "0.2.5");
        assert_eq!(view["nodeVersion"], "v24.22.2");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 1);
        assert_eq!(ready.load(Ordering::SeqCst), 1);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(changes.load(Ordering::SeqCst) >= 2);
        assert!(installation.is_ready());
    }

    #[test]
    fn installing_reports_the_real_step_and_bytes() {
        let fake = Arc::new(Fake::default());
        let installation = Installation::new(fake.clone(), None);
        let gate = fake.gate.lock().unwrap();
        installation.begin();
        let deadline = Instant::now() + Duration::from_secs(5);
        while installation.view()["step"] != "node" {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let view = installation.view();
        assert_eq!(view["downloaded"], 10);
        assert_eq!(view["total"], 100);
        drop(gate);
        settle(&installation);
    }

    #[test]
    fn an_outdated_installation_is_updated_on_start_after_its_runtimes_stop() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.outdated.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let view = installation.view();
        assert_eq!(view["state"], "update-required");
        assert_eq!(view["version"], "0.2.4");
        let (_, ready, stops) = counted(&installation);
        installation.begin();
        assert_eq!(settle(&installation)["state"], "ready");
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_eq!(ready.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_ready_installation_installs_nothing_on_start() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        installation.begin();
        assert_eq!(installation.view()["state"], "ready");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_installer_that_panics_ends_failed() {
        struct Panics;
        impl Installer for Panics {
            fn inspect(&self) -> Found {
                Found::Absent
            }
            fn files_present(&self) -> bool {
                false
            }
            fn install(&self, _: Action, _: &dyn Fn(Value)) -> Result<String, String> {
                panic!("boom")
            }
        }
        let installation = Installation::new(Panics, None);
        installation.begin();
        assert_eq!(settle(&installation)["state"], "failed");
    }

    #[test]
    fn a_failure_carries_its_reason_and_a_retry_installs_again() {
        let fake = Arc::new(Fake::default());
        fake.fail.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let (_, ready, _) = counted(&installation);
        installation.begin();
        let view = settle(&installation);
        assert_eq!(view["state"], "failed");
        assert_eq!(view["error"]["code"], FAILED);
        assert!(view["error"]["params"]["message"].as_str().unwrap().contains("offline"));
        assert_eq!(ready.load(Ordering::SeqCst), 0);
        fake.fail.store(false, Ordering::SeqCst);
        assert!(installation.start(Action::Install));
        assert_eq!(settle(&installation)["state"], "ready");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 2);
        assert_eq!(ready.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn asking_while_an_operation_runs_changes_nothing() {
        let fake = Arc::new(Fake::default());
        let installation = Installation::new(fake.clone(), None);
        let gate = fake.gate.lock().unwrap();
        assert!(installation.start(Action::Install));
        assert!(!installation.start(Action::Install));
        assert!(!installation.start(Action::Repair));
        drop(gate);
        settle(&installation);
        assert_eq!(fake.installs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_repair_replaces_a_ready_installation_after_stopping_its_runtimes() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let (_, ready, stops) = counted(&installation);
        assert!(installation.start(Action::Repair));
        assert_eq!(settle(&installation)["state"], "ready");
        assert_eq!(fake.repairs.load(Ordering::SeqCst), 1);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_eq!(ready.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn installing_a_tool_on_a_ready_installation_keeps_it_ready_and_its_runtimes_running() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let (_, ready, stops) = counted(&installation);
        let gate = fake.gate.lock().unwrap();
        assert!(installation.start(Action::Install));
        let view = installation.view();
        assert_eq!(view["state"], "ready");
        assert_eq!(view["operation"]["action"], "install");
        assert!(installation.is_ready(), "sessions keep starting");
        assert!(!installation.start(Action::Install));
        drop(gate);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !installation.view()["operation"].is_null() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        assert_eq!(ready.load(Ordering::SeqCst), 0);
        // A tool that could not be installed is reported; the runtime still runs.
        fake.fail.store(true, Ordering::SeqCst);
        assert!(installation.start(Action::Install));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !installation.view()["operation"].is_null() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let view = installation.view();
        assert_eq!(view["state"], "ready");
        assert_eq!(view["error"]["code"], FAILED);
    }

    #[test]
    fn runtime_files_lost_while_running_are_installed_again() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        assert!(installation.verify());
        // Something removed the app folder.
        fake.installed.store(false, Ordering::SeqCst);
        fake.files.store(false, Ordering::SeqCst);
        assert!(!installation.verify());
        assert_eq!(settle(&installation)["state"], "ready");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 1);
        assert!(installation.verify());
    }

    /// #158: Jouzu's Git Bash removed while the host runs.
    #[test]
    fn a_tool_lost_while_running_is_installed_again_beside_running_sessions() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let (_, ready, stops) = counted(&installation);
        fake.tool_lost.store(true, Ordering::SeqCst);
        assert!(installation.verify(), "sessions keep starting");
        let deadline = Instant::now() + Duration::from_secs(5);
        while fake.tool_lost.load(Ordering::SeqCst) || !installation.view()["operation"].is_null() {
            assert!(Instant::now() < deadline, "the tool was not installed again");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(installation.view()["state"], "ready");
        assert_eq!(fake.installs.load(Ordering::SeqCst), 1);
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        assert_eq!(ready.load(Ordering::SeqCst), 0);
        // One that cannot be installed is reported once, not tried at every check.
        fake.fail.store(true, Ordering::SeqCst);
        fake.tool_lost.store(true, Ordering::SeqCst);
        assert!(installation.verify());
        let deadline = Instant::now() + Duration::from_secs(5);
        while installation.view()["error"].is_null() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(installation.verify());
        assert!(installation.verify());
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(fake.installs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_repair_refused_by_a_terminal_jouzu_stops_nothing_and_stays_ready() {
        let fake = Arc::new(Fake::default());
        fake.installed.store(true, Ordering::SeqCst);
        fake.files.store(true, Ordering::SeqCst);
        fake.held.store(true, Ordering::SeqCst);
        let installation = Installation::new(fake.clone(), None);
        let (_, _, stops) = counted(&installation);
        installation.start(Action::Repair);
        let view = installation.view();
        assert_eq!(view["state"], "ready", "{view}");
        assert!(view["error"]["params"]["message"].as_str().unwrap().contains("terminal"), "{view}");
        assert!(installation.is_ready());
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        assert_eq!(fake.installs.load(Ordering::SeqCst), 0);
        // Closed: the same repair goes ahead.
        fake.held.store(false, Ordering::SeqCst);
        assert!(installation.start(Action::Repair));
        assert_eq!(settle(&installation)["state"], "ready");
        assert!(installation.view()["error"].is_null());
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        // An installation that cannot run anyway fails with the reason.
        fake.outdated.store(true, Ordering::SeqCst);
        let blocked = Installation::new(fake.clone(), None);
        fake.held.store(true, Ordering::SeqCst);
        blocked.start(Action::Update);
        let view = blocked.view();
        assert_eq!(view["state"], "failed", "{view}");
        assert_eq!(view["action"], "update");
    }

    #[test]
    fn the_refusal_carries_the_installation() {
        let fake = Arc::new(Fake::default());
        let installation = Installation::new(fake, None);
        let error = installation.not_ready();
        assert_eq!(error.code, "runtime-not-ready");
        assert_eq!(error.details.unwrap()["installation"]["state"], "absent");
    }

    #[test]
    fn files_are_not_replaced_while_a_terminal_jouzu_holds_its_lease() {
        let root = tempfile::tempdir().unwrap();
        let held = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open({
            std::fs::create_dir_all(root.path().join("updates")).unwrap();
            root.path().join("updates/sessions.lock")
        }).unwrap();
        #[cfg(not(windows))]
        held.lock_shared().unwrap();
        let error = lease(root.path()).unwrap_err();
        assert!(error.contains("terminal"), "{error}");
        drop(held);
        assert!(lease(root.path()).is_ok());
    }

    #[test]
    fn a_partly_installed_home_is_absent_and_an_old_one_needs_an_update() {
        let root = tempfile::tempdir().unwrap();
        let managed = Managed { root: root.path().to_path_buf(), runtime_home: root.path().join("data") };
        assert_eq!(managed.inspect(), Found::Absent);
        assert!(!managed.files_present());
        // A first install that stopped after the packages: no entry script yet.
        std::fs::create_dir_all(root.path().join("app/node_modules/jouzu")).unwrap();
        std::fs::write(root.path().join("app/node_modules/jouzu/package.json"), r#"{"version":"0.2.4"}"#).unwrap();
        assert_eq!(managed.inspect(), Found::Absent);
        // An older install: the app is there, its version and Node are not current.
        std::fs::write(root.path().join("app/bootstrap.mjs"), "").unwrap();
        assert_eq!(managed.inspect(), Found::Outdated { version: Some("0.2.4".into()) });
    }
}
