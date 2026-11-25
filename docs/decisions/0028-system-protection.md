# 0028 — The agent's tools run at a permission level the host owns

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

**Four permission levels.** The person picks one; a new session starts at **Workspace**.
The first three run the tools inside the sandbox with different settings; the fourth
turns it off.

| | Read-only | Workspace (default) | Unattended | Full access |
|---|---|---|---|---|
| Writes | None (own temporary folder only) | Workspace and own temporary folder, minus protected locations | As Workspace | Unrestricted |
| Reads | Whole machine minus credential folders | As Read-only | As Read-only | Unrestricted |
| Command network | Off | A list of common development domains; others ask | As Workspace | Unrestricted |
| Crossing the boundary | Asks the person; approval allows that one action and does not change the level | Asks the person: allow once, or for this folder or domain for the rest of the session | Never asks: refused, the reason goes to the model and is recorded in the session | No boundary |
| Tools covered | `bash`, `powershell` in the sandbox; `write`/`edit` refused and asked | `bash`, `powershell` in the sandbox; `write`/`edit` checked against the same boundary | As Workspace | None |
| Sandbox unavailable | Every command asks first | Every command asks first | Every command refused | Not affected |
| The person sees | Level name and "will not change files" | Level name, workspace path, network scope | Level name and the count of refusals, with details | A prominent risk marker, always visible |
| Switching to it | Any time; applies from the next tool call | Any time; the default for new sessions | Any time; switching away lists what was refused meanwhile | Confirmed against the risk every time; never remembered as the default |

In every case where the sandbox is unavailable, the person is told why and how to fix it.
Nothing falls back to running unprotected without the person's knowledge.

**Rules shared by all levels.**

- Protected locations (the installation, the data home, `.git/hooks` in the workspace) are
  never writable and credential folders (`~/.ssh`, cloud credentials, Jouzu's keys) never
  readable. Only Full access lifts this; approving a boundary crossing never does.
- Only a person approves, in the UI. Neither the agent nor a model approves anything, and
  no path lets the agent change the level.
- TextGuard is a separate setting with its own owner (the runtime) and does not change
  with the level.

**Who owns it.** The host ([0014](0014-three-layers-single-owner.md)). The host owns the
level, the session's approvals and whether the sandbox is available, and reports them in
its views. It hands the configuration for the current level to Desktop's extension and the
sandbox backend; neither keeps it as its own state, and it is never read from a file the
agent can write. The UI shows the level and requests a change; it does not hold the level.

**Where it plugs in.** The runtime is not changed. Desktop's extension uses the runtime's
public tool-override API, the only integration point that needs no runtime change, to run
`bash` and `powershell` in the sandbox and to check `write` and `edit`. A boundary question
is asked through the runtime's extension UI request and relayed by the host to the UI.
Anything the API cannot guarantee (for example that Desktop's tools cannot be replaced by
another extension) is a runtime gap ([0015](0015-runtime-facts-relayed-not-reinterpreted.md)),
recorded and raised, not worked around.

**Windows backend.** One backend serves the three sandboxed levels with different
configuration, so the prototype validates all four levels on it rather than one level
first. Candidates: sandbox-runtime's Windows support (alpha: a separate sandbox user,
write-restricted token, file ACLs and outbound filtering; needs an administrator once at
install) and a write-restricted token with a Desktop-owned SID and folder ACLs. The choice
is made on these requirements and recorded with its evidence:

- Git, npm, Node and Python work inside, in PowerShell and Git Bash.
- Reads of credential folders and writes outside the boundary are refused by the operating
  system, not by a check in the extension.
- Grants made on the person's folders are recorded and removed on uninstall.
- The cost per command is measured on real machines and does not slow a session noticeably.

## Does not mean

- It does not sandbox the runtime process, the model calls, MCP servers or third-party
  extensions. They run outside the boundary, as before; this record says so rather than
  implying otherwise.
- It is not a list of blocked paths or commands patched one by one. A gap found later is
  fixed by moving the boundary, not by adding a special case.
- It does not tie TextGuard to the levels or merge their state. Flow is run control, not
  permissions, and keeps its own panel.
- It does not fix the shell. PowerShell and Git Bash are both tried inside the sandbox;
  whichever works is used.
- It does not change readiness: the sandbox is applied per tool call, so a new session is
  still ready at once ([0016](0016-new-session-ready-at-once.md)). The cost per command is
  measured, not assumed.
- It does not let a model review boundary crossings, and it has no "ask every step" level:
  with the sandbox in place that only adds interruptions; Read-only is the careful choice.
- The concrete list of development domains, protected locations and credential folders is
  kept in [`../design/host-layer.md`](../design/host-layer.md), derived from what the tools
  and the runtime actually use; changing it does not need a new record.
- The Windows mechanism is a hypothesis until the prototype confirms it. If it fails, this
  record is revised before anything is built on it.
