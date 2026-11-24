# 0026 — The host owns the runtime installation

Status: Accepted.
Date: 2026-11-24

## Context

The desktop release carries no runtime ([0003](0003-no-bundled-runtime.md)): Node,
the Jouzu package and its tools are installed into the data home on first launch.
Whether that installation is present and current had three owners:

- the desktop shell checked it (`runtime_report`), installed it (`runtime_install`),
  updated it (`jouzu_update`) and repaired parts of it (`git_bash_install`,
  `terminal_install`, `repair_jouzu`, `image_tool_ensure`), each started by the UI;
- the host looked for the files again whenever it started a runtime, and refused
  with `runtime-missing` when they were not there; it also parsed the active version
  selection a second time and reported the same files in `/v1/status`;
- the UI kept its own `runtimePresent`, combined from the shell's report and from
  the host answering at all, and showed the host's `runtime-missing` in the chat.

On a first run on macOS and Linux the copies disagreed: the window skipped or cut
short the prepare screen and the first session failed with "runtime files are
missing". Web and remote clients could not see or start an installation at all,
which [0021](0021-web-and-remote-are-one-client.md) and
[0025](0025-desktop-on-tauri-mobile-native.md) require.

## Decision

- The runtime installation lives in the data home, which belongs to the host
  ([0018](0018-one-data-home-never-copied.md)). The host is the only owner of its
  state and the only code that installs, updates or repairs it.
- The host keeps one installation state and publishes it in `AppView`
  (`installation`): `absent`, `installing` (step and real progress),
  `update-required`, `ready` (versions) or `failed` (typed code). See
  [`../design/host-layer.md`](../design/host-layer.md) §7.2.
- The host checks the installation when it starts and installs or updates it on
  its own; no client has to ask. A client can ask again through one command (retry
  after a failure, an update offered in Settings, a repair).
- While the installation is not `ready`, the host refuses to start a session with
  a typed code. When it becomes `ready`, the host starts its warm runtime, so the
  first new session is ready at once ([0016](0016-new-session-ready-at-once.md)).
- A runtime whose files disappear while the host runs makes the installation
  `absent` again and is reinstalled, instead of telling the person to repair it.
- The UI renders `installation` and nothing else about it: the prepare screen, the
  failure with its retry, and the Settings rows. It keeps no copy.
- The shell keeps only what is its own: the window, the tray, native dialogs, its
  own updater, the terminal entries in the install folder, and starting the host.

## Does not mean

- The shell's own update (the Tauri updater) is not part of this; the host never
  replaces the desktop program.
- Installing on start is not a background surprise: the prepare screen shows it,
  as it does today, with no choices.
- The host still never waits on a caller's behalf: a session started too early is
  refused, not held until the installation finishes.
