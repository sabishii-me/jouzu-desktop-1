# Errors and notices

Status: draft v3 (2026-11-16), for discussion. Replaces v2 (one notice at a time
above the composer) and the 2026-11-14 design implemented in `9c2fd48`.

This document has two parts with different readers. **Part 1** is for the person
using the app: what they see and can do when something goes wrong, screen by
screen. **Part 2** is for the host/API: how errors are owned, classified and
exposed. The UI is designed from Part 1; it does not mirror Part 2.

---

## Part 1 — What the person sees

### Goals

- Something that cannot work is not offered. The person should rarely meet an
  error they could have been kept from.
- When something does fail, it shows **on the thing that failed**, and nothing else
  stops working.
- The screen never fills with text. A control's own state carries most of the
  meaning; words are a short label or a tooltip.
- Nothing moves when an error appears or clears. Nothing the person typed is lost.
  No toasts, no pop-ups they did not ask for.

### The conversation

- **A tool call fails.** Its card shows the failed state (icon and colour) and,
  when opened, its output. Tool calls running beside it carry on, and so does the
  reply.
- **A reply fails** (the model provider stopped it, timed out, ran out of credit).
  The reply ends with a failed marker and a short reason. The latest failed reply
  has Retry; earlier ones are just marked. The person can type and send as usual.
- **A message could not be sent.** The message stays in the conversation, dimmed,
  with Retry and Discard. Its text is never lost.

### The composer

The composer shows what can be done now; it does not explain what cannot.

- **Model not ready yet** (new session, catalog loading): the model button next to
  Send shows that it is loading. Send is unavailable; typing works.
- **No model available**: the model button becomes the way to set one up (opens
  Settings → Model providers). Send is unavailable; typing works.
- **A reply is running**: Send adds the message to the queue above the composer
  (each item can be edited or removed); Stop is next to it.
- **Near the length limit**: a character count appears; past the limit Send is
  unavailable.
- **The model has no image input**: the attach-image button is not shown.
- **Commands that cannot run during a reply** (compact, export) are not offered
  while it runs.
- **The session has ended** because of an error (its runtime failed and could not
  be recovered, a refused image is stuck in its history, Flow history is full):
  the composer is replaced by one line saying why and one button that recovers
  (Restart session, Remove images, Clear Flow history). This is the only thing
  that ever appears in the composer's place, and only one at a time, because an
  ended session cannot end again.

### Controls in the session

- **Changing the model fails**: the model button stays on the previous model and
  shows a small failed mark; its tooltip says why. The session is otherwise
  unchanged.
- **Stop, compact, export, a command fails**: the result shows at that control (the
  button's state, the command's own output line), not as a session message.

### Session header and sidebar

- **The window loses its connection to the host**: the header shows
  "Reconnecting…" and the composer is dimmed. The session keeps running in the
  host and the window catches up on reconnect. This is not a session error.
- The sidebar row shows whether a session is running or has ended; nothing else.

### Settings

- **A settings action fails** (key rejected, sign-in failed): that card shows a
  short reason under the action that failed. Other cards keep working.
- **Several actions in a row**: each button shows its own progress while it waits
  its turn; nothing fails because another action is running.

### Start page

- **The app cannot work** (host unreachable, runtime not installed): the start page
  says so in one line with the one action that fixes it.

### Extensions and MCP

- **An MCP server needs attention** (for example sign-in): its entry in the MCP
  menu shows the state and the action. It is not shown in the conversation and is
  not repeated each time a runtime starts.

### Words on screen

- One short line at most. If a state needs more than a line to explain, the
  layout is changed instead.
- Original technical text is available under Details where it helps (copyable,
  never translated), and never as the main sentence. Advice that only works in a
  terminal ("Run /mcp") is never shown.
- Every label and line exists in en, ja, zh-Hans and zh-Hant.
- Fixed sizes: showing or clearing any of the above never moves the composer, the
  conversation or the sidebar, and long tokens (paths, model ids) never widen the
  window.

---

## Part 2 — Host / API

### Ownership

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

### Rules

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

### Steer queue

The host owns the queue of messages sent while a reply runs and removes a message
only after the runtime confirms it used it; Stop returns unused ones to the queue.

---

## Acceptance

- Two tool calls run in parallel and one fails: only its card shows it; the other
  completes; the reply continues; the composer is unchanged.
- Changing the model fails: the model button stays on the previous model with its
  failed mark; nothing else on screen changes; nothing is reported twice.
- A reply fails: the reply is marked; the next message sends normally.
- The session ends (runtime killed, recovery refused): the composer is replaced by
  the reason and one action; no other error appears for that session; `host.log`
  has the cascade entries.
- A settings save fails while a catalog refresh runs: only that card shows it; the
  refresh completes.
- With no model, Send cannot be pressed; a direct API send gets `no-model`.
- Longest text and a long unbroken token at the smallest window: nothing moves or
  widens.
- All four locales complete; no toast component exists; no action ends with no
  visible outcome.

## Known gaps in the current build (1.1.3-rc.2)

- Errors from every source are collected into one list above the composer: they
  stack, one failure can appear twice, and operation failures (Stop, model change)
  look like session errors.
- Send is available before a new session has a model, so a message can vanish.
- A dropped event stream is shown as a session error.
- One settings action running makes the others fail with "Another configuration
  operation is running".
- MCP status repeats on every runtime start, with terminal advice.
- Chat text is hard-coded English; notices grow with their text and push the
  composer.
