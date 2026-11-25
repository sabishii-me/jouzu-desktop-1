# 0028 — The agent's commands run inside a sandbox the host owns

Status: Proposed (this pull request; merging accepts it). Windows first; macOS and Linux
follow in their own records once their platform support (#183) is in.
Date: 2026-11-25

## Context

The agent's tools run with everything the person can do. A shell command can write
anywhere in the person's profile, change the Desktop installation, its runtime and its
extensions, edit the data home (sessions, settings, credentials) and reach any network
address. A prompt injection or a plain mistake has the same reach. #197 asks for
operating-system isolation of the agent by default.

The runtime already has one protection of its own, TextGuard (a check on content, with
read-only status published by jouzu#72). It does not stop a command from doing what the
command does; that needs a boundary enforced by the operating system.

The runtime's public extension API lets an extension register a tool under the name of a
built-in one (`bash`, `powershell`, `write`, `edit`, …) and replace how it executes. Desktop
already ships its own extensions this way. So the boundary can be drawn around the tools
alone, with no change to the runtime: the agent process and its
model calls stay outside, only what the tools execute is inside.

## Decision

**What is protected.** One boundary: everything the agent's tools execute or change on
disk. It covers shell commands and every process they start, and the file tools that
change files.

- Writes are denied by default. A tool may write only inside the session's folder, a
  temporary folder of its own, and folders the person adds. Inside those, anything the
  runtime or the host will later run or trust as configuration (the runtime's extension
  and settings folders a workspace can carry, for example) stays read-only, so nothing
  written in the sandbox runs outside it later. The concrete list is derived from what the
  runtime and the host actually load, and kept in [`../design/host-layer.md`](../design/host-layer.md).
- The installation, the runtime, Desktop's extensions and the data home are never writable
  from the sandbox, wherever they are. This includes the folders the runtime protects from
  its own file tools (jouzu#62), so the two never disagree.
- Network for tool commands is either allowed or blocked, per protection level. The
  agent's model calls are not tool commands and are never affected.
- Tool commands get an environment built from an allow-list. Credentials the runtime holds
  (provider keys in its environment) are not passed to them.
- Reads stay open: closing them breaks ordinary development tools.
  Confidentiality comes from blocking the network, not from hiding files.

**Who owns it.** The host ([0014](0014-three-layers-single-owner.md)).

- The host owns the policy (level, writable folders, network) and whether the sandbox is
  available, and reports both in its views.
- The host's sandbox launcher creates the boundary for each command and reads the current
  policy from the host when it does. The runtime keeps no copy of the policy.
- Desktop's extension routes the tools through that launcher. Shell commands run under it;
  `write` and `edit` perform their change through it too, so there is one enforcement point
  (the operating system), not a second path check written in JavaScript.
- The runtime is not changed. Anything the extension API cannot guarantee (for example that
  Desktop's tools cannot be replaced by another extension) is a runtime gap
  ([0015](0015-runtime-facts-relayed-not-reinterpreted.md)), recorded and raised, not worked
  around.

**Windows requirements.** The backend is chosen against these, not the other way round:

- Standard protection works for a normal user: no administrator rights, no Developer Mode.
- Strict protection (network blocked) may need one administrator step at install; without
  it the host reports the network as not isolated and Strict as unavailable.
- Git, npm, Node and Python run normally inside, in PowerShell and in Git Bash.
- The policy comes only from the host, from a location the sandbox cannot write.
- Grants made on the person's folders are recorded and removed on uninstall.
- The cost per command is measured on the person's machines and does not slow a session
  noticeably.

Candidate backends, evaluated in the prototype on those requirements: sandbox-runtime
(open source, Windows support in alpha, separate sandbox user, needs administrator once)
and a write-restricted token with a Desktop-owned SID and folder ACLs (no administrator
needed for writes). The record is amended with the choice and the evidence.

**Default and failure.** On by default. When the sandbox cannot be created, a command is
refused with a typed reason at its own scope ([0017](0017-errors-at-their-scope.md)); it is
never run unprotected instead. Running without protection is only ever the person's
explicit choice.

**What the person sees.** One concept, **Protection**, with one control in the composer and
one kind of "blocked" notice. TextGuard and the sandbox are its two mechanisms. Each keeps
its own owner and state: TextGuard's in the runtime (relayed as reported), the sandbox's in
the host. The UI shows what each reports and infers nothing. Levels:

| Level | Sandbox | TextGuard |
|---|---|---|
| Standard (default) | Writes isolated; network allowed | On |
| Strict | Writes isolated; network blocked | Strict |
| Off | Off | Off |

Only the person changes the level, adds a writable folder or lowers protection. No path
lets the agent do it.

## Does not mean

- It does not sandbox the runtime process, the model calls, MCP servers or third-party
  extensions. They run outside the boundary, as before; this record says so rather than
  implying otherwise.
- It is not a list of blocked paths or commands patched one by one. A gap found later is
  fixed by moving the boundary, not by adding a special case.
- It does not merge TextGuard into the sandbox or their state into one source. Flow is run
  control, not protection, and keeps its own panel.
- It does not fix the shell. PowerShell and Git Bash are both tried inside the sandbox;
  whichever works is used.
- It does not change readiness: the sandbox is created per command, so a new session is
  still ready at once ([0016](0016-new-session-ready-at-once.md)). The cost per command is
  measured, not assumed.
- It does not decide a domain allow-list for the network. If blocking everything proves too
  strict in use, that is a later decision.
- The Windows mechanism is a hypothesis until the prototype confirms it. If it fails, this
  record is revised before anything is built on it.
