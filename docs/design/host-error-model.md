# Host error model

Status: draft (2026-11-16), for discussion. Together with
[ui-error-presentation.md](ui-error-presentation.md) it replaces
`errors-and-notices.md` (v2, one notice at a time above the composer) and the
2026-11-14 design implemented in `9c2fd48`.

This document is for the host and its API. It describes how errors are owned,
classified and exposed to any client (the desktop UI, nsh, scripts). It says
nothing about screens; what a person sees is in `ui-error-presentation.md`.

## Ownership

Runtime events and runtime text reach the host only. The host classifies them,
removes duplicates and exposes each error in the slot of its snapshot that matches
what it interrupted. Clients (the desktop UI, nsh, scripts) render the snapshot;
they do not parse runtime text.

| What failed | Slot | Clears |
|---|---|---|
| A tool call | `tool.result` with `ok: false` and reason | Never; history |
| A message not delivered | `queue[].error` | Sent or discarded |
| A reply | `lastRun.error` and the reply's record | Next run starts |
| A command in a session | the command's response code | — |
| The session ended | `failure`, `lifecycle = failed` (only via `Session::fail`) | Recovery action |
| A settings operation | `AppView.config.lastResult` | Next operation of that kind |
| App startup | `AppView.startup` | Cause gone |
| Extension / MCP status | the feature's own state, deduplicated per session | Resolved |

## Rules

1. **An error changes only what it interrupted.** It escalates only when the level
   above is really broken (for example the runtime exited and recovery failed),
   decided in one place. Lower-level errors caused by an escalation are not
   reported again; the host writes `notice.cascade` to `host.log` with both codes,
   and the cascade is fixed at its source.
2. **Operations in different scopes never block or fail each other.** Work that
   must be serial (the configuration channel) is queued by the host, not refused
   with `409`.
3. **Never trust the caller.** Every command checks its preconditions and refuses
   with a typed code. Codes are of two kinds:
   - *precondition* — the command cannot work in the current state (`no-model`,
     `session-stopped`, `text-too-long`, image limits, `session-busy`,
     `model-unavailable`). A client should not offer these paths; when one arrives
     without a race, the host logs `ui.illegal_path`.
   - *runtime* — a real failure (tool, provider, runtime exit, network, invalid
     key, model removed from the catalog at the moment of sending).
4. **Retry is decided per API and per error**, not by a blanket flag. Where a retry
   can succeed, the response says so.
5. **Text**: every error carries a code and parameters for the client to localize,
   and the original text for Details; the same is written to `host.log`.

## Steer queue

The host owns the queue of messages sent while a reply runs and removes a message
only after the runtime confirms it used it; Stop returns unused ones to the queue.
---

## Acceptance

- Two tool calls run in parallel and one fails: only that call's `tool.result`
  has `ok: false`; the other completes; the run continues; no other slot changes.
- Changing the model fails: the session keeps its previous model; the failure is
  in the command's response only; nothing is written to `failure` or `lastRun`.
- A reply fails: `lastRun.error` is set; the next send is accepted and clears it.
- The session ends (runtime killed, recovery refused): `failure` is set once,
  `lifecycle = failed`; no other error slot is written for that session;
  `host.log` has the `notice.cascade` entries.
- A settings save fails while a catalog refresh runs: only that kind's
  `lastResult` shows it; the refresh completes; no `409`.
- With no model, a direct API send gets `no-model`.
- Every error carries a code, its parameters and the original text.

## Known gaps in the current build (1.1.3-rc.2)

- Every kind of failure is written into one per-session notice list; operation
  failures (Stop, model change) and runtime information (MCP status) land there
  too, so one failure can be reported more than once.
- The configuration channel allows one operation at a time and refuses the rest
  with `409 control-busy`.
- Send is accepted before a new session has a model.
- Steer vs. prompt is decided from host-started turns only, so a run started by
  the runtime (Flow) is not treated as running.
