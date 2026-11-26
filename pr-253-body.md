## Issue

On a first run, the window could show "runtime files are missing" while the runtime was still being installed, and the user had to click Retry. That message is wrong: nothing is missing, the install just hasn't finished. Decision record: `docs/decisions/0029-runtime-installation-owned-by-host.md`.

## Root cause

Whether the runtime is installed and current had three owners:

- the shell checked it (`runtime_report`) and installed, updated and repaired it (`runtime_install`, `jouzu_update`, `recovery`);
- the host looked for the runtime's files again each time it started a runtime, and answered `runtime-missing` when they were not there yet;
- the UI kept its own `runtimePresent`.

These copies disagree during a first run. The shell is still installing, the UI already asks the host for a session, and the host reports the runtime missing. Earlier fixes changed which copy won the race. Each one was a patch, and the copies stayed.

## Change

**One owner: the host** (`apps/desktop/host/src/installation/`)
- `Installation` holds the state: `absent`, `installing` (action, step, downloaded/total bytes, tool), `update-required`, `ready` (version, Node version), `failed` (action and reason). Windows tool reports for Git Bash and Windows Terminal come with it.
- At start, the host checks what is on disk. A ready installation refreshes the desktop's own extensions. Anything else is installed or updated by the host on its own, with no client asking.
- Sessions are refused with `runtime-not-ready` (503) until the installation is ready, and the refusal carries the installation state. The warm pool starts when the installation becomes ready, and stops before the files are replaced.
- Lost files: the check that runs at each session start and every 15 s finds runtime files that disappeared while the host runs. The installation goes back to `absent` and the host installs it again. A lost tool (Jouzu's Git Bash, #158) is found the same way and installed again beside running sessions. A tool that cannot be installed is reported once in Settings, not retried at every check.
- Light operations: installing a missing tool on a ready installation replaces no runtime files. The state stays `ready`, sessions keep running, and the operation's progress and error are reported beside the state.
- Terminal Jouzu: an operation that replaces runtime files first takes the exclusive side of the lease that a terminal `jz` holds while it runs. If the lease is held, nothing is stopped. A ready installation stays ready and reports "Jouzu is running in a terminal. Close it, then try again."; an installation that cannot run anyway fails with that reason.
- An installer that panics ends `failed` instead of staying `installing`.
- `POST /v1/runtime/{install|update|repair}` asks for an operation and answers 202 with the installation. A host that was given its runtime answers 409 `runtime-not-managed`.
- `AppView.installation` publishes the state to every client, and `/v1/status` reports it instead of running its own file checks.
- The installer code (Node download and verification, package install, version policy, desktop extensions, Windows tool scripts) moved from the shell into the host unchanged in behavior. It is parameterized by the host's home. The host writes every file of the `jouzu-image` extension, including the ones #254 added (`report.mjs`, `providers/errors.mjs`, `providers/codex.mjs`); a test fails when a packaged extension file is not carried.

**UI**
- The prepare page renders `AppView.installation`: the real step, the downloaded bytes, and a failure with its reason and Retry. Retry repeats the operation that failed. While the host is not yet reachable, the window shows "Connecting".
- The Settings rows for Jouzu, Git Bash and Windows Terminal take their version, state, busy flag and error from the installation. Their install button asks the host.
- `runtime-missing` is replaced by `runtime-not-ready` in all four locales.

**Shell**
- The shell no longer checks, installs, updates or repairs the runtime. It drops these commands: `runtime_report`, `runtime_install`, `image_tool_ensure`, `jouzu_update` and recovery. It also drops the modules behind them. `component_versions` reports only the desktop build.

**Docs**
- ADR 0029 (0026–0028 were taken by other records), plus `host-layer.md` §7 and `ui-layer.md` (operations that keep sessions running, the lease, update with no version).

**CI**
- The runtime install and exam provision steps run the host's tests (`cargo test --locked --lib` in `apps/desktop/host`). `e2e/installation.spec.ts` is added to the mocked UI test lists.

Rebased on `develop` after #240 and #254. With #254 the shell's `image_tool.rs` only installed the extension, so it is removed. After #240: the host `/v1/status` no longer carries its own `git`/`terminal` file checks (the installation reports the tools), and the macOS/Linux release steps run the runtime install and exam provision tests in `apps/desktop/host`.

## Testing

**Unit tests**
- Host `cargo test --lib`: 260 pass on Linux, on `develop` with #240 and #254. Shell `cargo test --bins --features terminal-console`: 68 pass. New tests cover:
  - a first start installing on its own and refusing sessions until ready;
  - lost runtime files installed again;
  - a lost tool installed again beside running sessions, and reported once when it cannot be installed;
  - a repair refused by a terminal Jouzu, which stops nothing;
  - light operations;
  - an installer that panics;
  - the lease;
  - the route and `AppView.installation`.
- UI `npm test`: 345 pass. `npm run build` passes. The mocked UI specs in CI (`control-center`, `onboarding`, `tools`, `installation`): 24 pass.

**Mocked UI tests**
- `e2e/installation.spec.ts` (new) runs in a desktop window and in a browser. It covers a first run that shows the host's steps and opens the workspace with no early session request, a failure with Retry, and an installation that goes away while the window is open.
- `e2e/control-center.spec.ts` now reads the Settings rows from the installation.
- `e2e/installation-host.spec.ts` uses a real host that cannot download and shows the failure.

**Packaged acceptance, merged with #240** (fresh isolated home for every run)

Linux AppImage:
- A first run shows "Downloading Node…" with real MB, then "Installing packages…", and opens the workspace by itself in about 40 s. `runtime-missing` never appears.
- A runtime folder deleted while running is installed again, and no old runtime process is left.

macOS (Apple Silicon `.app`, ad-hoc signed):
- A first run is ready in 17 s, and `runtime-missing` never appears.
- Upgrading from a build before this change opens the workspace in 2 s with no reinstall, and the previous session is restored and answers.
- Offline, the window shows "Installation failed" with the reason and Retry. Retry fails again at once, with no hang. A relaunch online installs in 17 s.
- Files deleted while running: every old runtime process is gone within 3 s, the reinstall takes 15 s, and the open session reattaches and answers.

Windows x64:
- A first run downloads Node, then installs packages and tools, and opens the workspace by itself. A message and a bash call work.
- Upgrading from 1.1.5-rc.2 opens the workspace in about 2 s with no reinstall, and the rc.2 session keeps its history and answers.
- Offline: "Installation failed" with the reason and Retry, no hang. A relaunch online installs.
- Files deleted while running (`app` files; `node.exe` is in use and cannot be deleted): found in seconds and installed again. The open session works afterwards, and no old runtime process is left.
- Git Bash deleted while running (#158): found 12 s later and installed again in the background. The window stays on the workspace, every runtime keeps its process, Settings shows Jouzu's Git Bash again, and a bash call in the same session works.
- Terminal `jz` holding the lease: a repair is refused up front. Nothing is stopped, the window stays on the workspace, and the session answers. With `jz` closed, the repair succeeds.

- [x] Base branch is `develop`
- [x] A test covers the change
- [x] `npm test` and `npm run build` pass in `apps/desktop`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018W38Nueg4oauAwcwrdazqD
