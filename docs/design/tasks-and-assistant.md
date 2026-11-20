# Tasks, agent access (MCP) and the Assistant

Status: experimental (1.1.5 development). Host part implemented; no UI yet
except the agent-access card in Settings > Collaboration.

## Tasks

A task is an ordinary session started on a client's behalf
(`apps/desktop/host/src/tasks.rs`). The host keeps only what links the task
to its session: task id, session id, session file, folder, client, creation
time. The task's state is derived from the live session every time it is
read (decision 0018). The record also keeps the last state the host saw, used
only when the session is not open: how it ended, or that it was still running
when the host went away. Such a task is reported `stopped` once, on the next
start, so its client is not left waiting. A turn the user or client stopped
is `stopped`, never `finished`. A model a client asks for that the runtime
does not list is refused, never replaced by the default.

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

Every window hears of these changes on the host's global event stream, the
same one the session list already follows: `task.changed` (task id, client,
session, state; on start, when the session file is known, and on each state
change), `inbox.changed` (client, seq) and `project.changed` (project id).
They carry ids and states only; a window reads the rest itself. The remote
web page gets them the same way; nothing polls.

A task's session is an ordinary row in the session list. The host's session
lists add `task: {taskId, clientId, clientName}` to it, matched by live id or
by saved file, so it survives a restart; the task record is the only source.
The sidebar shows it with a small bot icon in place of the plain conversation
icon, its tooltip naming who started it (the Assistant, or an agent by the
name the user gave it). While it runs, waits or has an unseen end, the #212
state icon shows instead and its tooltip adds the starter. There is no
separate task list.

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
Scheduled wakes are kept on disk by wall-clock time, so a restart keeps a
reminder the Assistant already promised; one that came due meanwhile fires
when it is next idle.

### What it hears and reads

The person's own words travel unchanged. Each transcript row has a fixed id
(`m<line>`) and a user message reaches the Assistant as `[user message mN]`.
Its `start_task` and `send_task` take `quote` (ids of user messages): the host
puts those messages in front of the brief word for word, each marked as the
user's with its time, then `[Brief from the Assistant]`. Only user messages
can be quoted. MCP agents have no `quote`; they have no such conversation.

When the person writes in a task's session themselves (any message whose
client message id is not the task's own), the task's client gets an inbox
entry marked `userWrote`, kept until acknowledged whatever the state does
next; the Assistant's wake says so. This is seen only while the host follows
the task's session; a message in a session reopened later is not seen.

Like a project coordinator, the Assistant reads every session: `list_sessions`
(recent sessions in all folders, newest first, with task marks) and
`read_session` (whole messages; only sessions the host lists). It writes only
to its own tasks. MCP agents still see only their own tasks. The
`catch-requests` skill has it look for requests the person made elsewhere on a
scheduled wake, note them in the project, and ask before taking them on.

### Its pane

The sidebar entry "Assistant" opens its pane. From the top: the task sessions
waiting for the person (an approval or an answer; a click opens the session),
then the person's projects, each expanding to its linked sessions and tasks
with their state icons, then the conversation. Everything is read from the
host (the session list with its task marks, `/v1/projects`, the Assistant's
snapshot) and read again on `task.changed`, `project.changed` and
`assistant.changed`; the remote web page shows the same.

The entry carries a dot while the Assistant said something (a reply or an
error) the person has not seen, or while a task waits for them. The host keeps
one seen mark for every window (`POST /v1/assistant/seen`, sent when the pane
is shown), as it does for a session's unseen run end (#212). There are no
pop-ups.

### Its model

The Assistant plans and dispatches; it runs only on the model the user saved
in Settings > Collaboration (provider, id and reasoning effort). It never
falls back to jouzu's default or to whatever model has a key, and it never
switches: if that model is unusable it stops and shows why. Turning it on
without a model is refused.

Until a model is saved, Settings fills in a recommendation from
`packaging/desktop/assistant/recommended-models.json`, matched by model id
against the models the runtime lists. The recommendation is for planning
work, so its evidence is the closest orchestration benchmark (WorkflowArena,
arXiv 2611.12856), not a coding one. That benchmark delegates to worker
processes within one run, while the Assistant starts and follows separate
sessions, so it supports the choice rather than proving it: GPT-6.1 Sol at low effort by default,
GPT-6 Astra at xhigh as the stronger, costlier choice. Models for workflow
roles (the workers) are a separate choice, recommended from COSPA
(github.com/shisa-ai/cospa), a coding cost-performance benchmark.

### Views

The Assistant shows boards, tables, graphs, timelines and progress as fenced
`jouzu-view` JSON blocks, and anything else as `svg` blocks. The format the
Assistant is taught is `skills/draw-task-views.md`; it is the reference for
the UI that will draw them. Views name tasks by `taskId` only and the UI
fills in live state when it draws, so a view is never stale. The UI removes
scripts, event handlers, `foreignObject` and external references from SVG.

## Workflow and models

`apps/desktop/host/src/workflow.rs` reads and writes jouzu's workflow
definitions (`agents.json` in the runtime home: roles, their model tier,
tools, instructions). The runtime owns the format; the host checks the
runtime's own rules before writing, writes only over the revision the caller
read, refuses while the runtime holds the file's lock, and keeps every
version it replaces (`workflow-versions/` in the host home) so it can be
restored. Routes: `GET/PUT /v1/workflow`, `GET /v1/workflow/versions`,
`POST /v1/workflow/restore`. The Assistant has the same operations as tools.
Agents over MCP do not.

`start_task` takes an optional `model` (`{provider, id}`, from `list_models`)
for the task's session; the host relays it like a model picked in Desktop.
Turning Workflow on or off per task is not offered yet: it is a runtime
command that has to be checked against the runtime first.
