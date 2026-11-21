# Tasks, agent access (MCP) and the Assistant

Status: experimental (1.1.5 development). Host part implemented; no UI yet
except the agent-access card in Settings > Collaboration.

## Tasks

A task is an ordinary session started on a client's behalf
(`apps/desktop/host/src/tasks.rs`). The host keeps only what links the task
to its session: task id, session id, session file, folder, client, creation
time, and, for a task that never got a session, why (failed to start, or
stopped while it waited). It keeps no state: the task's state is derived every
time it is read (decision 0018), from the live session while it is open, and
from the session's run record otherwise.

How a session's latest run went is owned by one host record per session
(`session_runs.rs`, `session-runs.json` in the host home, keyed by session
file): when it started, when it ended, its outcome (done, failed, stopped, or
cut off) and whether a client has seen it since. The host writes it as runs
start and end, for every session, task or not. A run still marked running when
the host starts was cut off by the host going away; it is recorded so before
anything reads it, and a task in such a session is reported `stopped` once, so
its client is not left waiting. A stopped run is `stopped`, never `finished`.
The sidebar's unseen marks (#212) read the same record and show only done and
failed; a stopped or cut-off run lists like a session at rest. A model a client
asks for that the runtime does not list is refused, never replaced by the
default.

| State | Meaning |
|---|---|
| `waiting_to_start` | above the limit the user set in Settings > Collaboration (none by default; each running task holds one runtime, #93); starts when one ends |
| `starting`, `running` | as the session |
| `waiting_user` | an approval or question waits for the user |
| `held` | a message is held for the user (Flow) |
| `finished`, `failed`, `stopped` | the session's latest run ended so (cut off counts as stopped) |
| `unloaded` | the session is not open and no run of it is recorded; its file still answers `read_task` |

Operations return at once. Changes reach the client's inbox: one entry per
task (its latest state), increasing `seq`, read / ack / wait (long poll, as
long as the caller asks). Many tasks ending together are one short read.

The host sets no numbers of its own here (decision on invented limits): how
many tasks run at once is the user's setting (`GET/PUT
/v1/collaboration/tasks`, desktop window only), how many messages to read or
how long to wait is the caller's argument, and nothing has a size or count
cap. The host follows a task's session by its events and summary changes
only; nothing is polled.

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
(`assistant/memory`, one file per subject, no size of the host's own: the
model's context and the runtime's compaction bound it) and its transcript.
The process turns host messages into model turns and tool calls into host
requests; the line protocol is described at the top of `assistant.mjs`.

Turns are decoupled from events. A user message is delivered as soon as the
Assistant is idle. Task changes wake it as soon as it is idle, with a
one-line summary (how many tasks, by state); it reads and acknowledges its
inbox itself. Changes that arrive while it works are one wake when it is
done. There is no timer and no poll: the loop runs on a user message, the
Assistant going idle, an inbox entry, or a scheduled wake coming due. `schedule_wake` lets it look again later.
If the process ends it stays stopped until the user writes or turns it on.
Scheduled wakes are kept on disk by wall-clock time, so a restart keeps a
reminder the Assistant already promised; one that came due meanwhile fires
when it is next idle.

### What it hears and reads

The person's own words travel unchanged. Each transcript row has a fixed id
(`m<line>`) and a user message reaches the Assistant as `[user message mN]`.
A project keeps the ids of the person's messages that ask for its work
(`requestIds`; only user messages are accepted), and `list_projects` gives
them back word for word as `requests`. The Assistant checks results against
those words, not its retelling of them.

A task gets only the Assistant's brief, which must stand on its own: what to
do, why, and what done means. Nothing is added to it. (Adding the person's
words to the brief, even marked as background, made tasks act on requests
that were addressed to the Assistant, and made those words the title.) A
message type that carries a cited user message with its own meaning, which
the runtime would show and treat as context rather than instructions, is a
runtime need, not something the host imitates in text.

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

Desktop recommends no model of its own: a list baked into the package goes
stale and is a number Desktop made up. Which models suit planning is a fact
about models, so it belongs in the runtime's signed model catalog, next to
their limits and prices; that is a runtime need. Until the catalog carries
it, the user picks the model. (The earlier evidence, for the record:
WorkflowArena, arXiv 2611.12856, favoured GPT-6.1 Sol at low effort.) Models
for workflow roles (the workers) are a separate choice, recommended from COSPA
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
