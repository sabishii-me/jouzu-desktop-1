//! What owns a runtime's process tree: a Job Object on Windows, a process
//! group elsewhere. Terminating it ends the whole tree.

#[cfg(windows)]
mod platform {
    use std::{io, mem::size_of, os::windows::io::RawHandle};

    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job {
        handle: isize,
    }

    // The handle is an owned kernel handle; it is safe to move/share across tasks.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, windows::core::PCWSTR::null())
                    .map_err(|error| io::Error::other(error.to_string()))?;
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|error| {
                    let _ = CloseHandle(job);
                    io::Error::other(error.to_string())
                })?;
                Ok(Self {
                    handle: job.0 as isize,
                })
            }
        }

        pub fn assign(&self, process: RawHandle) -> io::Result<()> {
            unsafe {
                AssignProcessToJobObject(HANDLE(self.handle as *mut _), HANDLE(process))
                    .map_err(|error| io::Error::other(error.to_string()))
            }
        }

        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(HANDLE(self.handle as *mut _), 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(HANDLE(self.handle as *mut _));
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::{
        io,
        sync::atomic::{AtomicI32, Ordering},
    };

    /// The runtime's own process group. The child is spawned as the leader of
    /// a new group (`process_group(0)`), so the group holds every process it
    /// starts, as a Job Object does on Windows. Ending the group ends them all;
    /// so does dropping the last owner (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
    #[derive(Default)]
    pub struct Job {
        group: AtomicI32,
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            Ok(Self::default())
        }

        /// `pid` leads its own process group: it was spawned with `process_group(0)`.
        pub fn assign(&self, pid: u32) -> io::Result<()> {
            let group = i32::try_from(pid).ok().filter(|group| *group > 0).ok_or_else(|| io::Error::other("runtime process has no pid"))?;
            self.group.store(group, Ordering::SeqCst);
            Ok(())
        }

        pub fn terminate(&self) {
            let group = self.group.load(Ordering::SeqCst);
            if group > 0 {
                // An empty group answers ESRCH; nothing is left to end then.
                unsafe {
                    libc::killpg(group, libc::SIGKILL);
                }
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            self.terminate();
        }
    }
}

pub use platform::Job;

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use super::super::{process::spawn, SpawnSpec};

    /// Whether `pid` still runs. A killed process that its new parent has not
    /// reaped yet is a zombie, which `kill(pid, 0)` still finds; it runs nothing.
    fn running(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next()) != Some("Z"),
            Err(_) => !cfg!(target_os = "linux"),
        }
    }

    /// Stop, restart and reap end the runtime and whatever it started, as the
    /// Job Object does on Windows.
    #[tokio::test]
    async fn terminating_ends_the_runtime_and_what_it_started() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("grandchild");
        let script = format!("sleep 600 & echo $! > '{}'; wait", marker.display());
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script],
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            workspace: directory.path().to_path_buf(),
            low_priority: false,
        };
        let mut spawned = spawn(&spec).unwrap();
        let mut grandchild = None;
        for _ in 0..500 {
            if let Some(pid) = std::fs::read_to_string(&marker).ok().and_then(|text| text.trim().parse::<i32>().ok()) {
                grandchild = Some(pid);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let grandchild = grandchild.expect("the runtime started a process");
        assert!(running(grandchild));
        spawned.job.terminate();
        tokio::time::timeout(Duration::from_secs(5), spawned.child.wait()).await.expect("the runtime ended").unwrap();
        let mut ended = false;
        for _ in 0..500 {
            if !running(grandchild) {
                ended = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(ended, "the process the runtime started still runs");
    }
}
