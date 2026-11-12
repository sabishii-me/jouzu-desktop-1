//! Spawn one runtime process inside a Job Object.
//!
//! The child is created suspended so it cannot run user code before it is
//! assigned to the job, then resumed. stdio stays with the supervisor.

use std::{io, process::Stdio, sync::Arc};

use tokio::process::{Child, Command};

use super::job::Job;
use super::SpawnSpec;

pub struct Spawned {
    pub child: Child,
    pub job: Arc<Job>,
    pub pid: u32,
}

pub fn spawn(spec: &SpawnSpec) -> io::Result<Spawned> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.workspace)
        .env_clear()
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }

    let child = command.spawn()?;
    let pid = child.id().unwrap_or_default();
    let job = Arc::new(Job::new()?);

    #[cfg(windows)]
    {
        let handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("runtime process has no handle"))?;
        job.assign(handle)?;
        resume(pid)?;
    }

    #[cfg(not(windows))]
    {
        let _ = &child;
    }

    Ok(Spawned { child, job, pid })
}

#[cfg(windows)]
fn resume(pid: u32) -> io::Result<()> {
    use windows::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
            THREADENTRY32,
        },
        System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    };

    if pid == 0 {
        return Err(io::Error::other("runtime process has no pid"));
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|error| io::Error::other(error.to_string()))?;
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut resumed = false;
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                        .map_err(|error| io::Error::other(error.to_string()))?;
                    if ResumeThread(thread) == u32::MAX {
                        let error = io::Error::last_os_error();
                        let _ = CloseHandle(thread);
                        let _ = CloseHandle(snapshot);
                        return Err(error);
                    }
                    let _ = CloseHandle(thread);
                    resumed = true;
                    break;
                }
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        if !resumed {
            return Err(io::Error::other("runtime main thread was not found"));
        }
    }
    Ok(())
}
