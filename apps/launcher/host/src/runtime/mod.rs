//! Runtime process ownership.
//!
//! One supervisor owns one runtime process and its stdio. The rest of the host
//! never touches a pipe, a `Child`, or the process lock.

pub mod job;
pub mod process;
pub mod supervisor;

pub use supervisor::{RequestError, RuntimeEvent, RuntimeSupervisor};

use std::ffi::OsString;
use std::path::PathBuf;

/// Everything needed to start one runtime process.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(OsString, OsString)>,
    pub workspace: PathBuf,
}
