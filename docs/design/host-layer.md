# Host layer: state ownership, contract and error model

Status: draft (2026-11-16), for discussion. Baseline: develop `d89f8a2`
(1.1.3-rc.2). Part of a three-layer design: [runtime](runtime-layer.md),
**host** (this document) and [UI](ui-layer.md).

This document covers the host and its HTTP/SSE API. Its readers are the people
writing the host and anyone writing a client (the desktop UI, nsh, scripts). It
describes no screens; what a person sees is in the UI document.

## 1. Responsibilities

- The host is the only owner of session state, the model catalog, configuration
  operations and errors.
- Runtime events and runtime text reach the host only. The host classifies them,
  removes duplicates and writes the result into its snapshots. Clients render
  snapshots; they never parse runtime text.
- The host never trusts the caller. Every command checks its preconditions and,
  when they fail, refuses with a typed code. The host does not wait or fall back
  on the caller's behalf.
- The host knows nothing about layout. It exposes state and commands, not copy
  or screens.

## 2. State ownership

| State | Single owner | Copies today (to be removed) |
|---|---|---|
| Model catalog and default model | host `ModelCatalog` | None (step 4 removed the UI lists, the stored preference and the host's adopt-on-listing) |
| Run state, including runs started by Flow | host `Session.run` | Host: `active_turn` and `status = Running` disagree. UI: infers busy on its own |
| Queue of messages sent during a run | host `Session.queue` | UI-local queue |
| Configuration operations | host `ConfigQueue` | Operations now wait their turn in the host (no `409`); the UI still queues some of its own, and there is no `operationId` yet |
| Errors | host error slots (section 6) | UI builds one notice list from about 14 inputs |

## 3. Runs

- A run starts on the runtime's `agent_start` and ends on `agent_settled`,
  whoever started it (the person, or the runtime itself: Flow, an extension).
  `run.origin` records who (`user` / `runtime`). The host keeps exactly one run;
  status (`running`, waiting on an approval or question, `idle`) is derived
  from it, never stored beside it.
- A send claims the run only when none is in progress and no prompt of ours is
  still unanswered; claiming and the queue check happen together, so a message
  never waits behind a run that has just ended. Otherwise it goes to the queue.
- The prompt is written only if its run is still the one in progress. If the
  runtime starts a run of its own first, that run replaces ours and our message
  goes back to the front of the queue (`delivering` while the runtime still has
  the prompt, `queued` otherwise); the runtime's answer to the prompt decides
  what happens to it (refused: steered into the run; `handled`: done or held;
  `started`: it is the run).
- During a run, queued messages are handed over as steers once the run takes
  them: it is streaming and its first reply has started, and it is not retrying,
  compacting or stopping. Until then they stay `queued`.
- Stop is one host command for the run in progress, whoever started it. The
  host decides how: a prompt still parked for the runtime's start is removed
  (`cancelled`); anything else is aborted (`cancelling`, shown as the run's
  phase), and a run that starts only after Stop is aborted when it does.
  Waiting messages are returned to the caller (`returned`), who continues or
  discards them.
- Queue states: `queued` (waiting for the run), `delivering` (the runtime has it
  and has not answered; it can no longer be edited or removed), `held` (an
  extension took it and delivers it itself), `returned` (after Stop).
- A message leaves the queue only after the runtime confirms it used it.
- Open question: confirm that a message sent while a Flow run is streaming is
  delivered as a steer under these rules.

## 4. Model catalog

- The host loads the catalog eagerly at start, with a `revision`. It does not
  depend on a client calling `GET /v1/models`. It lists the catalog again after
  every configuration change and after `POST /v1/models/refresh`.
- The catalog holds chat models only. A catalog model with no output limit
  (Shisa Translate) is not a chat model and is left out.
- When the catalog changes, the revision increases and `models.changed` is sent.
  A warm runtime is recycled once per settings change (by whatever changed the
  settings) or when refreshed catalogs bring a new list; the first listing
  describes what it already loaded and recycles nothing.
- If the first listing fails, the catalog is `failed` with its error; new
  sessions have no model (`unavailable`), and a client retries with
  `POST /v1/models/refresh` (a plain listing again, as at start).
- A new session uses the default model. The default exists in one place only:
  the jouzu runtime's default-model setting. With none saved (a first sign-in),
  the runtime picks the model a new conversation starts on by its own rules
  (last used, the catalog's recommended model), which the host does not
  repeat: the session's runtime is started at once and the session is
  `resolving` until it reports its model.
- When the person changes the model in a session, the host calls RPC `set_model`
  (session only) and, on success, makes it the default at once, so the next new
  session uses the last selected model however soon it is created. It writes
  the runtime default through the ConfigQueue behind the answer; writes go one
  at a time and each writes the latest pick. Until a listing reports it, the
  pick stands over the runtime's older default; if writing fails, the default
  is the runtime's again. Settings writes the default the same way, so
  whichever comes last wins. Since the runtime re-applies the thinking level
  for the new model, a level picked before the runtime started is sent after
  the `set_model` answer, and otherwise the host reads the state again.
- A send needs a model; a slash command (`/flow`, `/textguard`) does not, and a
  retried message gets its earlier answer before any check.
- A session's model state is `resolving`, `ready` or `unavailable`. It is
  derived from the session's model and the catalog, never stored beside them.
  Send is refused unless it is `ready` (`no-model` or `model-unavailable`).
- A session with no model takes the default as soon as the catalog has one,
  whether it was created before the first listing or saved without a model. A
  saved conversation keeps the model it used, even one the catalog no longer
  lists (it is then `unavailable` until the person picks another).
- If changing the model fails, the session keeps its previous model. The failure
  is in that command's result only; it is not a session error.

## 5. Configuration queue

- Every operation that changes configuration (save key, sign in, refresh the
  catalog, save environment variables, language) goes through one host queue and
  runs serially. `409 control-busy` is removed. (Done in step 4: an operation
  waits its turn instead of being refused. Still open: `operationId` and
  `AppView.config`.)
- Each operation immediately gets an `operationId` and its queue position.
  `AppView.config` shows what is running, what is queued and the last result of
  each kind of operation.
- Operations in different scopes never block each other: while the queue is
  busy, sending, Stop and model changes in sessions work as usual.

## 6. Error model

### 6.1 Slots by scope

Each error is written to the slot that matches what it interrupted.

| What failed | Slot | Clears |
|---|---|---|
| A tool call | `tool.result` with `ok: false` and reason | Never; history |
| A message not delivered | `queue[].error` | Sent or discarded |
| A reply (run) | `lastRun.error` and the reply's record | Next run starts |
| A command in a session (stop, compact, export, model change) | The command's response code; `lastAction` where needed | Next command of that kind |
| The session ended | `failure`, `lifecycle = failed`, entered only through `Session::fail` | Recovery succeeds |
| A settings operation | `AppView.config.lastResult[kind]` | Next operation of that kind |
| App startup | `AppView.startup` | Cause gone |
| Extension / MCP status | The feature's own state, deduplicated per session | Resolved |

A dropped connection between a client and the host is not a host error and is
not recorded; the client handles reconnecting.

### 6.2 Rules

1. **An error changes only what it interrupted.** It escalates only when the
   level above is really broken (for example the runtime exited and recovery
   failed), and escalation is decided in one place.
2. **Cascades are not reported twice.** Lower-level errors caused by an
   escalation are not reported again; the host writes `notice.cascade` with both
   codes to `host.log`, and the cascade is fixed at its source.
3. **Operations in different scopes never block or fail each other.** Work that
   must be serial is queued by the host, not refused.
4. **A session error means one thing: the session was ended by an error.** There
   is at most one at a time, never a list.

### 6.3 Codes

- **Precondition**: the command cannot work in the current state. `no-model`,
  `model-unavailable`, `session-stopped`, `session-busy`, image
  count and size limits. A client should not offer these paths; when one arrives
  without a race, the host logs `ui.illegal_path`.
- **Runtime**: a real failure. Tool failure, provider stopped / timed out / out
  of quota, runtime exit, network, invalid key, model removed from the catalog at
  the moment of sending.
- Every error carries a `code`, parameters for the client to localize, and the
  original text (never translated). The same is written to `host.log`.

### 6.4 Retry

Retry is decided per API and per error, not by a blanket flag. When a retry can
succeed, the response says so. Examples:

| API | Retry can succeed | Retry cannot succeed |
|---|---|---|
| Send message | Provider timeout, network | Precondition codes |
| Change model | Runtime temporarily busy | `model-unavailable` |
| Save key | Network | Invalid key |
| Recover session | Runtime failed to start (limited attempts) | Refused image in history (remove it first) |

## 7. Contract

### 7.1 SessionView (per session)

| Field | Content |
|---|---|
| `lifecycle` | `pending` / `starting` / `ready` / `recovering` / `stopped` / `failed` |
| `run` (sent as `activeTurn`) | `id`, `origin` (`user` / `runtime`), `phase` (`starting` / `running` / `cancelling`), `startedAt`, `step`, `clientMessageId?` |
| `queue[]` | Message, state (`queued` / `held` / `delivering` / `returned`), `error?` |
| `model` | `provider`, `id`, `name`, `state` (`resolving` / `ready` / `unavailable`), `catalogRevision`, `thinkingLevels` |
| `thinkingLevel` | Current value |
| `lastRun.error` | Failure of the last reply |
| `lastAction` | Result of the last in-session command |
| `failure` | Why the session ended, and the available recovery (`restart` / `remove-images` / `clear-flow`) |
| `flow`, `textguard` | Their own state |

The session list entry carries what the host holds for a session even while it
is idle (`queued` count, `hasFailedTurn`), so a client opens such a session
through the host, never from its saved file, which has none of it.

### 7.2 AppView (global)

| Field | Content |
|---|---|
| `models` (`GET /v1/models`, `models.changed`) | `revision`, `state` (`loading` / `ready` / `failed`), `models[]` (chat models), `default`, `stale`, `error` |
| `settings` | Current settings |
| `config` | `running`, `queued[]`, `lastResult[kind]` |
| `startup` | State and cause |

### 7.3 Events and commands

- SSE events: `session.updated` (full snapshot), `app.updated`, `models.changed`,
  `settings.changed`. Snapshots carry a sequence number; a client catches up by
  sequence after reconnecting.
- Commands are HTTP. Each returns acceptance or a typed refusal synchronously;
  the resulting state is read from snapshots.

## 8. Host code to remove

- ~~`adopt_listed_default`~~ (removed in step 4).
- Steer decided from `active_turn`.
- ~~The single-operation `409` in control and its retry loop in `models.rs`~~ (removed in step 4).
- Operation failures and runtime information mixed into `session.notice`.

## 9. Host steps

The overall order alternates host and UI steps; each state class is done in the
host, then the UI, then verified on the packaged build before the next.

| Step | Change | Acceptance |
|---|---|---|
| 2 | Runs driven by `agent_start` / `agent_settled`; steer decision; `held` / `returned` queue states | A send during a Flow run becomes a steer; after Stop, unused messages are back in the queue |
| 4 | ModelCatalog: eager, revisioned, remembers the last selected model | A session can be created without any client calling `/models`; after a model change, new sessions use it |
| 6 | ConfigQueue | Saving a key while the catalog refreshes: both complete, no `409` |
| 8 | Error slots, escalation, codes, `host.log` | One of two parallel tool calls fails: only its `tool.result` changes; a session ends: exactly one `failure`, cascades in the log; with no model, a direct API send gets `no-model`; every error has code, parameters and original text |

## 10. Known gaps in the current build (1.1.3-rc.2)

- Every kind of failure goes into one per-session notice list; operation failures
  (Stop, model change) and runtime information (MCP status) land there too, so
  one failure can be reported more than once.
- Steer vs. prompt is decided from host-started turns only, so a run started by
  the runtime (Flow) is not treated as running.
