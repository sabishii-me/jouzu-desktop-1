<!-- claude-projects-attribution: {"github_login":"c0dt"} -->

## Issue

Part of #183 (Desktop on macOS and Linux). Releases ship macOS and Linux packages again, PR checks cover both platforms, and the host lock bug found on macOS is fixed. Still open in #183 after this: writing down the bash choice and the macOS/Linux process-group scope of `docs/decisions/0010`.

## Root cause

Every release since 1.0.14 has been Windows-only:

- `desktop-release.yml` (QA) and `desktop-stable.yml` (stable) have only a Windows job, and `desktop-feed.mjs` writes only `windows-x86_64` and accepts only an `.exe`.
- The only macOS and Linux packages ever published (1.0.12 and 1.0.13) were built by the manual `desktop-installers.yml` and uploaded by hand. They had no updater signature and no feed entry, and they could not start a session, because the host only looked for `node.exe` until #181. That workflow was removed in #149 because it duplicated `desktop-release` and never built the host.
- `desktop-checks.yml` runs only on Windows, so nothing ever built or tested the host on macOS or Linux. That is how the host lock bug went unnoticed: on macOS and Linux, `HostLock::acquire` only opened `host.lock` and `is_locked` always returned `false`, so two hosts could run on the same data home. This was reproduced on macOS with the 1.1.4 and 1.1.5-rc.2 hosts.

## Change

**Releases (QA and stable)**
- `desktop-release.yml` and `desktop-stable.yml` gain a `unix` job for macOS (Apple Silicon, `macos-latest`) and Linux (x64, `ubuntu-22.04`). It runs the same gate as the Windows job: the UI build and unit tests, the mocked UI tests, the release host and its tests, the native tests, the runtime install without a system Node, and the packages. Stable also runs the full exam on each platform.
- Publishing needs every platform. The publish job downloads all three, checks that every file is there, verifies every updater signature and writes `SHA256SUMS.txt` over all of them.
- Release files (names come from `desktop-feed.mjs`, the only place they are defined):
  - Windows: `JouzuDesktop_<v>_x64-setup.exe` (+ `.sig`)
  - macOS: `JouzuDesktop_<v>_aarch64.dmg`, plus `JouzuDesktop_<v>_aarch64.app.tar.gz` (+ `.sig`) for the updater
  - Linux: `JouzuDesktop_<v>_amd64.AppImage` (+ `.sig`) and `JouzuDesktop_<v>_amd64.deb` (+ `.sig`)
- The feed has `windows-x86_64`, `darwin-aarch64`, `linux-x86_64` (AppImage) and `linux-x86_64-deb`. The updater looks up `<os>-<arch>-<bundle>` before `<os>-<arch>`, so an installation from the `.deb` updates with the next `.deb` and never with the AppImage. `desktop-feed.mjs` refuses a feed that is missing a platform, and `verify-feed.mjs` checks that every platform's file can be read.
- macOS packages are ad-hoc signed (`bundle.macOS.signingIdentity: "-"`) until Developer ID signing and notarization are set up. Until then, a downloaded app needs `xattr -cr "/Applications/Jouzu Desktop.app"` once before it opens.
- `RELEASE-CHANNELS.md` documents the platforms.

**PR checks**
- `desktop-checks.yml` (renamed to "Desktop checks") gains macOS and Linux jobs: the UI build and unit tests, host tests, native shell tests and mocked UI tests.

**Code**
- Host: on macOS and Linux, `HostLock` takes an exclusive `flock` (`File::try_lock`). After locking, it checks that the locked file is still the one at `host.lock`. A host that exits removes the file while it still holds it, so a host that opened the old file starts over instead of holding a lock that nobody else sees. The kernel releases the lock when a process dies. Windows is unchanged.
- Host `/v1/status` reports `git` as present outside Windows, the same as the shell's runtime report: Jouzu installs its own Git only on Windows.
- `console` (the terminal entry program behind `jz`/`jouzu`) runs the managed Node at `runtime/node/bin/node` outside Windows. It is now built only for Windows, through the `terminal-console` feature that `tauri.windows.conf.json` turns on, because only the Windows installer creates terminal entries. Without this, the `.deb` would install `/usr/bin/console`. The Windows package is unchanged.
- Host lifetime on macOS and Linux: Windows ends the host with the window through the job object (`KILL_ON_JOB_CLOSE`); macOS and Linux had nothing, so after a crash, Force Quit or `kill -9` of the window the host kept running and held the lock, and the next launch exited with no window and no message. The host now takes `--exit-with-stdin` and stops cleanly when its standard input closes (sessions shut down, `host.json` and the lock removed). The window passes it with a piped stdin whose write end lives as long as the window process, so the system closes it however the window ends. The host also stops cleanly on SIGTERM. This is the usual Unix way to tie a helper to its parent (language servers exit when stdin closes); Linux's `PR_SET_PDEATHSIG` has no macOS counterpart.
- On that binding:
  - A normal quit closes the host's stdin instead of killing it, so the host shuts its sessions down and removes `host.json` and its lock. Windows still ends the host through the job.
  - A stopping host ends its event streams (`begin_shutdown`). Otherwise the graceful shutdown waits for clients to hang up, and an open window never does.
  - A host started with `--exit-with-stdin` waits for the previous host to release the home (`HostLock::acquire_after_previous`, a blocking `flock`) instead of refusing. The app runs one window at a time, so that holder belongs to a window that has already ended and is stopping; reopening right after a Force Quit just starts. A host started by hand still refuses at once.
  - Stdin is watched from the moment the host starts, so a host whose window ends while it is still waiting exits at once and never starts.
  - `host.json` belongs to the host: the window no longer deletes it before starting a host (that removed a live host's discovery), and a host drops discovery left by a dead host once it holds the home.
- A start that truly fails shows a native alert on macOS and Linux too (`rfd`, which `tauri-plugin-dialog` already builds), as `MessageBoxW` does on Windows. The alert now includes the host's own reason (its last stderr line) instead of only "stopped before it was ready".
- Runtime processes on macOS and Linux: the host's runtime job was a Windows Job Object and did nothing elsewhere. On macOS and Linux, stopping, restarting or reaping a session, replacing a warm runtime and stopping runtimes before their files are replaced ended nothing, so runtimes ran until the host quit and closed their input. An idle Mac had accumulated 16 runtimes, 11 of them left over from replaced warm runtimes. Each runtime (and the configuration process) now starts as the leader of its own process group, and the job owns that group: terminating it sends SIGKILL to the whole group, as `TerminateJobObject` does on Windows. A group id is its leader's pid, which the system may reuse once the leader is reaped, so the job reaps the leader itself. It waits for the leader to exit without reaping it (`waitid` with `WNOWAIT`), ends whatever the leader left in its group, then reaps it and never signals that group again. Dropping the job signals nothing.
- Test: `two_new_sessions_in_a_row_both_get_a_started_runtime` waited for exactly two warm runtimes. The pool keeps filling up to four, and with the fake runtime ready in about 30 ms it can pass two between two polls, which failed this PR's checks on all three platforms. The test now waits for at least two, which is what it checks.
- `cookie` 0.18.2 → 0.18.3: RUSTSEC-2026-0594 (published 2026-11-23) fails the release audit.

## Testing

- `node --test packaging/desktop/desktop-feed.test.mjs packaging/desktop/verify-feed.test.mjs`: 12 pass. New tests cover missing or unknown platforms, the release file list, the command line that reads signatures from the release folder, and an unreadable bundle for one platform.
- Host `cargo test` on Linux: 225 unit tests pass, including `a_live_lock_refuses_a_second_host_and_keeps_host_json` and `only_one_of_two_concurrent_acquires_wins`, which failed on macOS before this change.
- Shell `cargo test --bins --features terminal-console` on Linux: console 15 pass, desktop 70 pass.
- The release workflow ran with publish off on all three platforms, and all jobs passed (audit, Windows, macOS, Linux). macOS and Linux each built and passed their full gate, and the run's artifacts hold the DMG, the AppImage and the deb.
- Linux package built locally with a throwaway updater key: the AppImage and `.deb` signatures verify with `verify-updater-signature.mjs`, the generated feed has all four entries, the `.deb` contains only `/usr/bin/jouzu-desktop`, and it depends on `libwebkit2gtk-4.1-0`, `libgtk-3-0` and `libayatana-appindicator3-1`. Launching the AppImage under Xvfb with a fresh home installs Node and jouzu into `$XDG_DATA_HOME/Shisa.ai/JouzuDesktop`, starts the host and shows the chat screen.
- `host/tests/exit_with_stdin.rs`: the host stops and removes `host.json` and `host.lock` when its stdin closes, and the next start succeeds; without the flag a closed stdin changes nothing. Before the fix, a host whose parent was killed with SIGKILL kept running and kept `host.json` and the lock. `the_host_stops_with_an_event_stream_still_open`: with `/v1/events` open, closing stdin still stops the host (it hung for 30 s without `begin_shutdown`). `a_waiting_host_ends_with_its_window`, `discovery_left_by_a_dead_host_is_replaced`, `a_new_window_host_starts_once_the_previous_one_has_stopped` and `a_window_host_waits_for_the_previous_host_to_let_go`: a second window host waits while the first holds the home and starts once it stops. With the real Linux AppImage, `kill -9` of the window now ends the host within seconds, `host.json` and the lock are gone, and relaunching immediately after `kill -9` shows the chat window with no start failure.
- PR checks on this branch pass on Windows, macOS and Linux, including the two host lock tests on macOS.
- macOS package (DMG from the publish-off run, Apple Silicon, fresh isolated home):
  - The DMG verifies. The app is ad-hoc signed, and `codesign --verify --deep --strict` passes.
  - A quarantined copy is rejected by Gatekeeper, and `xattr -cr` clears it as documented.
  - First launch: the host is ready in about 1 s, Node 24.22.2 and jouzu 0.2.5 install, the chat window renders in WKWebView and a session starts.
  - A second host on the same home exits with "Another jouzu-host is already running".
  - A normal quit stops the window and the host, and the next launch reopens the previous session.
  - `kill -9` of the window reproduced the orphaned host fixed above.
- macOS re-test after the fix (app built from this branch, fresh isolated home):
  - `kill -9` of the window: `jouzu-host` exits in about 1 s, logs `host.stop` with `result=ok`, and removes `host.json` and `host.lock`.
  - Relaunch shows the chat window and reattaches the previous session.
  - A normal quit leaves no `jouzu-host` or runtime process.
  - A start that fails (lock held by another host) shows the native alert "Jouzu Desktop could not start".
  - The update check finds no `darwin-aarch64` entry until a feed with macOS entries is published, which is expected.
- macOS re-test of the lifecycle changes (app built from this branch, fresh isolated home):
  - Cmd+Q: the host and all its runtime processes exit, `host.stop` logs `result=ok`, and `host.json` and `host.lock` are gone.
  - `kill -9` of the window, then an immediate relaunch: exactly one host runs and the chat window opens with no alert.
  - `kill -9` of the window, then wait: the host and its runtime processes exit in under 0.1 s and leave nothing behind.
  - A host started by hand holds the home, then the app opens: after 15 s the alert reads "Another jouzu-host is already running (pid N, port P). Stop it before starting a new one.", and that host's `host.json` is unchanged.
  - `kill -9` of the window while its host waits for the home: the waiting host exits in under 0.1 s and never starts; the running host and its `host.json` are untouched.

- Runtime process groups: `terminating_ends_the_runtime_and_what_it_started` fails without the change (the runtime never ends) and passes with it; `a_runtime_that_exits_takes_what_it_started_and_the_job_lets_go` checks that a runtime that exits on its own leaves nothing running and that the job forgets its group. Host `cargo test --lib`: 227 pass on Linux; the host type-checks for Windows and macOS.
- Linux AppImage, runtime folder deleted while running: before, the 4 old runtimes kept running beside the 5 new ones; after, none are left.
- macOS (app built from this branch, fresh isolated home), counting runtime processes: idle 5 (one session and 4 warm); after 5 settings changes that reload the configuration and adding a provider, still 5, and the old warm processes are gone within 3 s each time; 6 sessions, 10; after adding and switching workspaces, 7; quit, 0. With the runtime folder deleted while running, every old runtime is gone within 3 s and the open session reattaches and answers. A session whose runtime is killed recovers on a warm runtime and nothing of the old group is left. No leftover runtime at any point.

- [x] Base branch is `develop`
- [x] A test covers the change
- [x] `npm test` and `npm run build` pass in `apps/desktop`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
