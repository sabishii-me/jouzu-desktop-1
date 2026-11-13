//! A runtime started ahead of need.
//!
//! Starting a runtime costs seconds to minutes on a busy machine (Node start plus
//! extension imports). The pool starts one in the background, below normal
//! priority, before anyone asks for it. A session that needs a runtime takes the
//! warm one, raises it to normal priority and switches it to its own session
//! file; the pool then starts the next one. Until a session takes it, the pool
//! drains the runtime's output itself so its pipes never fill.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use super::{process, RuntimeEvent, RuntimeSupervisor, SpawnSpec};

/// How long a warm runtime may take to answer its first request.
const READY_TIMEOUT: Duration = Duration::from_secs(300);
/// Failed warm-ups are retried this many times in a row, then the pool stops
/// until a session asks again; a broken install should not spin the CPU.
const MAX_FAILURES: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarmState {
    /// No warm runtime and none starting.
    Off,
    /// Process started; it has not answered yet (Node and extensions loading).
    Starting,
    /// Answered its first request: a session can use it at once.
    Ready,
    /// The last warm-up failed; `error` says why.
    Failed,
}

impl WarmState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

struct Slot {
    generation: u64,
    runtime: Arc<RuntimeSupervisor>,
    /// Where the runtime's events go once a session takes it.
    target: Arc<Mutex<Option<mpsc::Sender<RuntimeEvent>>>>,
}

struct Inner {
    state: WarmState,
    slot: Option<Slot>,
    generation: u64,
    started_at: Option<Instant>,
    ready_ms: Option<u64>,
    error: Option<String>,
    failures: usize,
    taken: u64,
}

pub struct WarmPool {
    spec: Box<dyn Fn() -> SpawnSpec + Send + Sync>,
    inner: Mutex<Inner>,
    changed: Box<dyn Fn(Value) + Send + Sync>,
    ready: Notify,
}

impl WarmPool {
    /// `spec` builds the spawn spec for a warm runtime (no session-specific
    /// environment, a scratch working folder). `changed` is told the pool's
    /// state each time it changes.
    pub fn new(
        spec: impl Fn() -> SpawnSpec + Send + Sync + 'static,
        changed: impl Fn(Value) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            spec: Box::new(spec),
            inner: Mutex::new(Inner {
                state: WarmState::Off,
                slot: None,
                generation: 0,
                started_at: None,
                ready_ms: None,
                error: None,
                failures: 0,
                taken: 0,
            }),
            changed: Box::new(changed),
            ready: Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Value {
        let inner = self.lock();
        Self::describe(&inner)
    }

    fn describe(inner: &Inner) -> Value {
        json!({
            "state": inner.state.as_str(),
            "elapsedMs": inner.started_at.map(|at| at.elapsed().as_millis() as u64),
            "readyMs": inner.ready_ms,
            "error": inner.error,
            "taken": inner.taken,
            "pid": inner.slot.as_ref().map(|slot| slot.runtime.pid()),
        })
    }

    fn notify(&self) {
        let status = self.status();
        (self.changed)(status);
    }

    /// Start a warm runtime unless one is already there or starting.
    pub fn fill(self: &Arc<Self>) {
        let generation = {
            let mut inner = self.lock();
            if inner.slot.is_some() || inner.failures >= MAX_FAILURES {
                return;
            }
            inner.generation += 1;
            inner.state = WarmState::Starting;
            inner.started_at = Some(Instant::now());
            inner.ready_ms = None;
            inner.error = None;
            inner.generation
        };
        let mut spec = (self.spec)();
        spec.low_priority = true;
        if let Err(error) = std::fs::create_dir_all(&spec.workspace) {
            self.failed(generation, format!("Could not prepare the warm-up folder: {error}"));
            return;
        }
        let (event_tx, mut event_rx) = mpsc::channel(256);
        let runtime = match RuntimeSupervisor::start(spec, event_tx) {
            Ok(runtime) => runtime,
            Err(error) => {
                self.failed(generation, format!("Could not start the runtime: {error}"));
                return;
            }
        };
        let target: Arc<Mutex<Option<mpsc::Sender<RuntimeEvent>>>> = Arc::new(Mutex::new(None));
        {
            let mut inner = self.lock();
            inner.slot = Some(Slot {
                generation,
                runtime: runtime.clone(),
                target: target.clone(),
            });
        }
        self.notify();

        // Drain until a session takes the runtime, then forward everything.
        let pool = self.clone();
        let forward = target.clone();
        tokio::spawn(async move {
            let mut stderr_tail: Vec<String> = Vec::new();
            while let Some(event) = event_rx.recv().await {
                let sender = forward
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                if let Some(sender) = sender {
                    if sender.send(event).await.is_err() {
                        return;
                    }
                    continue;
                }
                match event {
                    RuntimeEvent::Stderr(line) => {
                        stderr_tail.push(line);
                        if stderr_tail.len() > 20 {
                            stderr_tail.remove(0);
                        }
                    }
                    RuntimeEvent::Exited(code) => {
                        let tail = stderr_tail.join("\n");
                        let mut message = format!(
                            "The warm runtime exited before use (code {}).",
                            code.map(|code| code.to_string())
                                .unwrap_or_else(|| "none".to_string())
                        );
                        if !tail.is_empty() {
                            message.push('\n');
                            message.push_str(&tail);
                        }
                        pool.failed(generation, message);
                        return;
                    }
                    _ => {}
                }
            }
        });

        // Ready once it answers a request: Node is up and the extensions loaded.
        let pool = self.clone();
        tokio::spawn(async move {
            let result = runtime
                .request(
                    json!({ "id": format!("warm-{generation}"), "type": "get_state" }),
                    READY_TIMEOUT,
                )
                .await;
            match result {
                Ok(_) => {
                    {
                        let mut inner = pool.lock();
                        if inner.slot.as_ref().map(|slot| slot.generation) != Some(generation) {
                            return;
                        }
                        inner.state = WarmState::Ready;
                        inner.failures = 0;
                        inner.ready_ms = inner
                            .started_at
                            .map(|at| at.elapsed().as_millis() as u64);
                    }
                    pool.ready.notify_waiters();
                    pool.notify();
                }
                Err(error) => {
                    // A runtime that a session already took is that session's
                    // business now; only a waiting one is retired here.
                    let waiting = pool
                        .lock()
                        .slot
                        .as_ref()
                        .is_some_and(|slot| slot.generation == generation);
                    if waiting {
                        runtime.terminate();
                        pool.failed(generation, format!("The warm runtime did not answer: {error:?}"));
                    }
                }
            }
        });
    }

    fn failed(self: &Arc<Self>, generation: u64, message: String) {
        let retry = {
            let mut inner = self.lock();
            if inner.generation != generation {
                return;
            }
            if inner
                .slot
                .as_ref()
                .is_some_and(|slot| slot.generation == generation)
            {
                inner.slot = None;
            } else if inner.slot.is_some() {
                return;
            }
            inner.state = WarmState::Failed;
            inner.error = Some(message);
            inner.failures += 1;
            inner.failures < MAX_FAILURES
        };
        self.ready.notify_waiters();
        self.notify();
        if retry {
            let pool = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                pool.fill();
            });
        }
    }

    /// Hand the warm runtime to a session: its events go to `events` from now
    /// on, it runs at normal priority, and the pool starts the next one. A
    /// runtime that is still starting is handed over too: the session waits for
    /// less than it would for a new one.
    pub fn take(self: &Arc<Self>, events: mpsc::Sender<RuntimeEvent>) -> Option<Arc<RuntimeSupervisor>> {
        let slot = {
            let mut inner = self.lock();
            let slot = inner.slot.take()?;
            inner.taken += 1;
            inner.state = WarmState::Off;
            inner.started_at = None;
            inner.ready_ms = None;
            // A session asking is a fresh reason to try again after failures.
            inner.failures = 0;
            slot
        };
        *slot
            .target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(events);
        process::set_low_priority(slot.runtime.pid(), false);
        self.notify();
        // The session refills the pool once its own runtime has answered.
        Some(slot.runtime)
    }

    /// A session needs a runtime but none is warm: allow the pool to try again
    /// after earlier failures.
    pub fn reset_failures(&self) {
        self.lock().failures = 0;
    }

    /// Wait until the warm runtime is ready or the warm-up failed, up to
    /// `timeout`. Returns the state at that point.
    pub async fn wait_settled(&self, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let notified = self.ready.notified();
            {
                let inner = self.lock();
                if !matches!(inner.state, WarmState::Starting) {
                    return Self::describe(&inner);
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || tokio::time::timeout(left, notified).await.is_err() {
                return self.status();
            }
        }
    }

    /// Settings the runtime reads at start changed: replace an unused warm
    /// runtime so the next session does not get the old settings.
    pub fn recycle(self: &Arc<Self>) {
        let slot = {
            let mut inner = self.lock();
            inner.failures = 0;
            inner.generation += 1;
            inner.state = WarmState::Off;
            inner.slot.take()
        };
        if let Some(slot) = slot {
            slot.runtime.terminate();
        }
        self.fill();
    }

    pub fn stop(&self) {
        let slot = self.lock().slot.take();
        if let Some(slot) = slot {
            slot.runtime.terminate();
        }
    }

    /// The folder warm runtimes start in, under the host home.
    pub fn scratch(home: &std::path::Path) -> PathBuf {
        home.join("warm")
    }
}
