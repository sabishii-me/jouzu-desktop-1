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

        /// Wait for the job's process to exit. The job ends what it left
        /// running when it is closed.
        pub async fn wait(&self, child: &mut tokio::process::Child) -> io::Result<std::process::ExitStatus> {
            child.wait().await
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
    use std::{io, process::ExitStatus, sync::Mutex};

    use tokio::process::Child;

    /// The runtime's own process group. The child is spawned as the leader of
    /// a new group (`process_group(0)`), so the group holds every process it
    /// starts, as a Job Object does on Windows. Ending the group ends them all.
    ///
    /// A group id is the leader's pid, and the system may give that pid to a
    /// new process once the leader is reaped and the group is empty. So the
    /// group is signalled only while its leader is not reaped: [`Job::wait`]
    /// waits for the leader to exit without reaping it, ends what is left of
    /// the group, and only then reaps the leader. After that the job signals
    /// nothing, and nothing signals the group when the job is dropped.
    #[derive(Default)]
    pub struct Job {
        /// The group while its leader is not reaped; 0 after.
        pub(super) group: Mutex<i32>,
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            Ok(Self::default())
        }

        /// `pid` leads its own process group: it was spawned with `process_group(0)`.
        pub fn assign(&self, pid: u32) -> io::Result<()> {
            let group = i32::try_from(pid).ok().filter(|group| *group > 0).ok_or_else(|| io::Error::other("runtime process has no pid"))?;
            *self.group.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = group;
            Ok(())
        }

        pub fn terminate(&self) {
            // Held while signalling: the leader is not reaped before this returns.
            let group = self.group.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *group > 0 {
                unsafe {
                    libc::killpg(*group, libc::SIGKILL);
                }
            }
        }

        /// Wait for the group's leader (`child`) to exit, end whatever it left
        /// running in its group, then reap it. The only way the leader is reaped.
        pub async fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
            let leader = *self.group.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if leader > 0 {
                // Exited but not reaped: its pid, and so the group id, stays taken.
                let exited = tokio::task::spawn_blocking(move || loop {
                    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                    let result = unsafe { libc::waitid(libc::P_PID, leader as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
                    if result == 0 {
                        return Ok(());
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                })
                .await
                .map_err(io::Error::other)?;
                let mut group = self.group.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if exited.is_ok() {
                    unsafe {
                        libc::killpg(*group, libc::SIGKILL);
                    }
                }
                *group = 0;
            }
            child.wait().await
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
        tokio::time::timeout(Duration::from_secs(5), spawned.job.wait(&mut spawned.child)).await.expect("the runtime ended").unwrap();
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

    /// A runtime that ends on its own leaves nothing of its group running, and
    /// once it is reaped the job signals nothing: its group id may belong to
    /// another process by then.
    #[tokio::test]
    async fn a_runtime_that_exits_takes_what_it_started_and_the_job_lets_go() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("grandchild");
        let script = format!("sleep 600 & echo $! > '{}'; exit 0", marker.display());
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script],
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            workspace: directory.path().to_path_buf(),
            low_priority: false,
        };
        let mut spawned = spawn(&spec).unwrap();
        tokio::time::timeout(Duration::from_secs(5), spawned.job.wait(&mut spawned.child)).await.expect("the runtime ended").unwrap();
        let grandchild: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        let mut ended = false;
        for _ in 0..500 {
            if !running(grandchild) {
                ended = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(ended, "the process the runtime started still runs");
        assert_eq!(*spawned.job.group.lock().unwrap(), 0, "the job still names the group");
    }
}
