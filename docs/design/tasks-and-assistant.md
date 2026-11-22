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
cap. A task takes its place under the limit when it is chosen to start, in
the same step that checks for room, so tasks started together (a client's
parallel calls) never pass the limit. The host follows a task's session by
its events and summary changes only; nothing is polled.

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

`apps/desktop/host/src/assistant.rs`, `packaging/desktop/assistant/`,
`packaging/desktop/extensions/jouzu-assistant/`.
A project coordinator that is a jouzu session with its own configuration, not
the coder's. The host starts a jouzu runtime for it the way it starts one for
any session (same program, environment and process job, after any runtime
booting beside it has done its start-up work), in the Assistant's own folder,
with:

- `--system-prompt prompt.md`: the Assistant's prompt instead of the coder's
  (jouzu still adds its own sections, such as the reply language);
- `--session-dir`, `--session-id assistant`: its own conversation, continued
  after a restart;
- `--tools`: its own tools plus `read`, `grep`, `find`, `ls`, and nothing
  else (no shell, no writing files, no subagents, no background jobs);
- `--no-extensions -e jouzu-assistant`, `--no-skills --skill` for each of its
  skills, `--no-context-files`, `--no-mcp`, `--no-prompt-templates`;
- Flow off (`JOUZU_FLOW_CONTROL=0`) and TextGuard off (`--jouzu-textguard-off`).

Its models and sign-ins are jouzu's: after the runtime answers, the host sets
the model the user chose with `set_model` (and the reasoning effort), exactly
as for a session. A model the runtime refuses stops the Assistant with the
runtime's own words; it never runs on another model.

The host owns the prompt (`prompt.md`), the skills (`skills/*.md`), the tools
(run on the host as client `assistant`), the Assistant's memory
(`assistant/memory`, one file per subject, no size of the host's own: the
model's context and the runtime's compaction bound it) and its transcript.
The jouzu-assistant extension only bridges: it registers the tools the host
lists (`tools.json`) and sends each call to `/v1/assistant/bridge` with a
token the host makes for that runtime alone (in its environment). That route
takes no other token, the host's included, and only on the internal listener.
A user message or wake is a `prompt`; a failed model call is an error in the
transcript; `agent_settled` makes the Assistant idle again.

The Assistant speaks only with the `say` tool: one or two short sentences in
plain spoken words per call (no Markdown, since they will be read aloud), each
shown at once as a chat message, several calls when there is more. Details
(lists, tables, views, drawings) are attached with `show`: drawn in the pane
in a card, never read aloud. The
model's own text, the turn's last message included, is never shown: it is its
thinking aloud. When the user writes during a turn, the host aborts the turn
(the runtime's `abort`), and a `say` after that answers `interrupted` with the
words that were not said, which never reach the transcript; the user's message
is the next turn. Commands to the runtime have no deadline of the host's:
they end when the runtime answers, exits or is stopped. A question an extension asks is declined at once:
nobody sits at the Assistant's runtime to answer it.

What jouzu 0.2.5 still adds that the Assistant cannot turn off (runtime
gaps, recorded, not worked around): the release extensions are always passed
by jouzu itself, so their skills (for example multiloop) are listed in the
prompt, and the workflow extension's subagents section says subagents are
enabled. Neither gives the Assistant a tool: `--tools` declares only its own
and the read-only ones, and Pi refuses any other call.

Turns are decoupled from events. A user message is delivered as soon as the
Assistant is idle. Task changes wake it as soon as it is idle, with a
one-line summary (how many tasks, by state); it reads and acknowledges its
inbox itself. Changes that arrive while it works are one wake when it is
done. There is no timer and no poll: the loop runs on a user message, the
Assistant going idle, an inbox entry, or a wake trigger firing. `schedule_wake` lets it look again later.
If the runtime ends it stays stopped, with the reason, until the user writes or turns it on.
A scheduled wake is a one-time trigger (see Triggers) created by the
Assistant: on at once, kept on disk by wall-clock time so a restart keeps a
reminder it already promised, and one that came due meanwhile fires once.
`schedule_wake` returns its id and `cancel_wake` removes it, so a wake set
to check on work that is already delivered does not come.

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
then the conversation. Projects are kept by the host and used by the Assistant
but not shown in the pane for now; what to show is decided later. Everything
is read from the host (the session list with its task marks, the Assistant's
snapshot) and read again on `task.changed` and `assistant.changed`; the remote
web page shows the same.

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
`jouzu-view` JSON blocks, and anything else as `svg` blocks, always in `show`. The format the
Assistant is taught is `skills/draw-task-views.md`, the one source of it; a
UI test reads every example there. Its pane draws every view the skill
teaches (`src/task-views.tsx`, layout in `src/task-views-model.ts`):

- Views name tasks by `taskId` only. Their titles and states are looked up
  when the view is drawn: the state from the host (`GET /v1/assistant/tasks`,
  read again on `task.changed`), the title from the session list. A task opens
  its session; one with no session yet shows its id and state.
- board: columns of tasks; table: the Assistant's cells plus a State column;
  graph: layered by the longest chain of dependencies, every edge pointing
  forward (a cycle is still drawn); timeline: in date order, dates shown in
  the interface language's format; progress: counts
  from live states (finished, failed or stopped, waiting for you, under way).
- `svg` is drawn at its viewBox scale, narrowed to fit, after removing
  scripts, event handlers, `foreignObject`, links, images, references outside
  the drawing and CSS imports. Nothing in it runs.
- A block that cannot be read says why in place (which field, or the JSON
  error) above its source; it is never shown as plain code or breaks the
  message. Each drawn view can show its source.
- Wide views (board, graph) scroll inside their frame, so the page never
  scrolls sideways at phone width (remote web).

## Triggers

"When this happens, do that", kept by the host (`triggers.rs`, data in
`<host home>/triggers/`). This is step 1 of the loop engine: later steps add
graphs that a trigger starts, human checkpoints, and connectors as event
sources.

A trigger has:

- a source: a time (`at`, `everySeconds`, or both), `manual` (only when the
  user presses Run), or an event kind (`task.ended`, `run.ended`; connector
  events later);
- a filter on the event's fields: a value, a list (any of them), or a string
  with `*`;
- an action: wake the Assistant with a note, start a run of a graph (its
  parameters from the event; a parameter that is only `{{field}}` keeps the
  field's type), or start a task in one of the user's folders. `{{field}}` in the text takes the event's field; a field
  the event does not carry fails the firing instead of running with words
  missing;
- its state (`proposed`, `enabled`, `paused`, `done` for a one-time trigger
  that fired), who created it, when it last fired and when it fires next.

Rules:

- Every firing is recorded with its event (`firings.jsonl`) before the action
  runs. One event fires a trigger once, across restarts too.
- Triggers only see events. A timer, a task ending, or later a connector
  polling or a webhook all arrive the same way, so changing how an event is
  received does not change triggers.
- A time trigger missed while the host was off fires once on start; a
  repeating one then moves to its next time after now. The host sets no
  numbers: how often it repeats is the trigger's own data.
- No loops: a task or run a trigger started carries the triggers that led to
  it (`triggeredBy`, passed on to the tasks a run starts), and a trigger
  never fires on the end of work it led to.
- Tasks a trigger starts are the user's (client `desktop`), counted against
  the user's limit like any task.

Who decides: the user, over `/v1/triggers` (list, create, change, pause,
delete, Run, firings). Agents with MCP tokens cannot reach it. The
Assistant may `propose_trigger`: the proposal does nothing (no firing, no
Run) until the user turns it on, because a trigger can start work and spend
money while nobody watches. The Assistant can withdraw its own proposal and
cancel its own wakes, and nothing else. There is no UI yet; the data and API
come first.

## Graphs and runs (the loop engine)

Strong processes come from orchestration, not from the model. A graph is
data (`<host home>/graphs/<id>/v<N>.json`); the engine (`runs.rs`) only
interprets it. Each run is a file (`<host home>/runs/<runId>.json`) with
the graph version it uses, its parameters, and every attempt; its evidence
files are beside it. The engine moves only on events (a task ending, a
command exiting, the user deciding), so a restart picks runs up where they
were: a task that ended meanwhile is judged, a command the host cut off runs
again.

Nodes:

| Kind | Does | Results |
| --- | --- | --- |
| agent | Starts a task (the user's, client `desktop`) with the brief | `done` when the turn ended and every file in `outputs` exists; `undelivered` when some are missing; `failed` when the task failed or stopped |
| check | Runs a command with the system shell in the folder | `passed` on exit 0, else `failed`; exit code, stdout and stderr are kept |
| checkpoint | Stops; the question and what to look at become the user's to-do | `approved`; or the user sends the run back to a node in `sendBack` with a note, or stops it |

Edges are `{from, to, when, attempts?}`. The first edge from the node whose
`when` is the result, and whose `attempts` (if any) the node has reached in
this run, is taken. That is how a graph leaves a loop: "after the second
failed check, ask the user" is an edge; the engine holds no number. With no
matching edge, `done`, `passed` or `approved` finish the run and any other
result fails it, with the reason. A note the user sends back with goes into
the next attempt's brief word for word. Briefs, folders, commands and
questions take `{{param}}`, `{{runId}}`, `{{evidence}}` (the run's evidence
folder) and `{{note}}`.

What "done" means is the engine's, not the model's. A gap stays recorded:
"its background processes ended" needs a process group per runtime (plan
stage 7); until then an agent step is done when its turn ended and its
outputs exist.

Reports: when a run waits for the user, a step ends badly, or a run ends,
the engine itself adds a `report` row to the Assistant's pane with the facts
(`waiting`, `step`, `ended`); the pane words them in the user's language. A
run ending is also a `run.ended` event for triggers.

Who decides:

- Graphs are the user's (`PUT /v1/graphs/{id}` saves a new version; old ones
  stay). The Assistant may `propose_graph`; it is used only after the user
  accepts it (`/v1/graphs/{id}/proposal/accept`).
- Runs start from the user (`POST /v1/runs`), a trigger, or the Assistant
  when the user asks (`start_run`).
- Checkpoints are answered only at `POST /v1/runs/{id}/decision`, with the
  host token. The Assistant and MCP agents read runs and to-dos
  (`list_runs`, `get_run`, `list_todos`) and have no way to decide.
- The user can stop a run at any time (`POST /v1/runs/{id}/stop`); its task
  and command stop with it.

MCP agents can also write to the Assistant in the user's place
(`assistant_send`, `assistant_messages`), for drills where an agent plays the
user; the pane shows which agent wrote. There is no UI for graphs, runs or
to-dos yet.

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

`start_task` requires a `model` (`{provider, id}`, from `list_models`) for the
task's session; there is no default, so every task runs on a model someone
chose. A model `list_models` does not show is refused. The host relays it like
a model picked in Desktop. `send_task` takes an optional `model`, set on the
task's session before the message is sent.

A task carries its `model`, and a failed task carries `failure`
(`{code, text, provider, model}`): the code is the host's provider error code
(quota, auth, model-unavailable, rate-limit, unavailable, image, other), the
text is the provider's own words. Both are in the inbox entry and in
`get_task`. The Assistant tells the user which task failed, on which model and
why, offers models from `list_models`, and waits: it never switches models or
retries on its own. The Assistant's own model failing is shown in its
workspace as an error; the user handles that.
Turning Workflow on or off per task is not offered yet: it is a runtime
command that has to be checked against the runtime first.
