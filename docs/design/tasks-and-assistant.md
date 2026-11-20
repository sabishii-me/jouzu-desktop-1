# Tasks, agent access (MCP) and the Assistant

Status: experimental (1.1.5 development). Host part implemented; no UI yet
except the agent-access card in Settings > Collaboration.

## Tasks

A task is an ordinary session started on a client's behalf
(`apps/desktop/host/src/tasks.rs`). The host keeps only what links the task
to its session: task id, session id, session file, folder, client, creation
time. The task's state is derived from the live session every time it is
read and is never stored (decision 0018).

| State | Meaning |
|---|---|
| `waiting_to_start` | above the cap (4 running tasks, one runtime each, #93); starts when a slot frees |
| `starting`, `running` | as the session |
| `waiting_user` | an approval or question waits for the user |
| `held` | a message is held for the user (Flow) |
| `finished`, `failed`, `stopped` | the last turn ended so |
| `unloaded` | the session is not open now; its file still answers `read_task` |

Operations return at once. Changes reach the client's inbox: one entry per
task (its latest state), increasing `seq`, read / ack / wait (long poll, at
most 60 s). Many tasks ending together are one short read.

Tasks run only in folders the user added, never send slash commands, and a
client sees only its own tasks. `policy::authorize` is called before every
operation and `policy::launch_profile` before every process start; both allow
today and are where the sandbox (#197) will decide.

## Agent access (MCP)

`apps/desktop/host/src/mcp.rs`. Off by default; the user turns it on in
Settings > Collaboration, which only the Desktop window can change. It listens
on `127.0.0.1` (default port 47615) at `/mcp`, answers initialize, ping,
tools/list and tools/call, and accepts notifications. Host and Origin must be
loopback names.

Each agent has its own token, shown once; the host keeps its SHA-256 only.
Agent tokens open nothing but `/mcp`; the host token does not open `/mcp`.
The tools are the task operations. Nothing that is the user's to decide is
offered: approvals and answers, Flow, TextGuard, keys and environment, tool
and web-access settings, adding folders, deleting sessions, slash commands.

## The Assistant

`apps/desktop/host/src/assistant.rs`, `packaging/desktop/assistant/`.
A project coordinator that is its own Node process on the Pi SDK's public
API, not a jouzu session: no jouzu extensions, Flow, TextGuard or jouzu
system prompt. Desktop installs a pinned copy of the SDK on first use and the
process reads jouzu's `auth.json` and `models.json` for the model.

The host owns the prompt (`prompt.md`), the skills (`skills/*.md`), the tools
(run on the host as client `assistant`), the Assistant's memory
(`assistant/memory`, one file per subject, at most 4 KB) and its transcript.
The process turns host messages into model turns and tool calls into host
requests; the line protocol is described at the top of `assistant.mjs`.

Turns are decoupled from events. A user message is delivered as soon as the
Assistant is idle. Task changes wake it only when idle, after a quiet period
(3 s) and no sooner than 30 s after the last wake, with a summary; it reads
and acknowledges its inbox itself. `schedule_wake` lets it look again later.
If the process ends it stays stopped until the user writes or turns it on.

### Views

The Assistant shows boards, tables, graphs, timelines and progress as fenced
`jouzu-view` JSON blocks, and anything else as `svg` blocks. The format the
Assistant is taught is `skills/draw-task-views.md`; it is the reference for
the UI that will draw them. Views name tasks by `taskId` only and the UI
fills in live state when it draws, so a view is never stale. The UI removes
scripts, event handlers, `foreignObject` and external references from SVG.
