# UI error presentation

Status: draft (2026-11-16), for discussion. Together with
[host-error-model.md](host-error-model.md) it replaces `errors-and-notices.md`.

This document is for the desktop UI. It describes, screen by screen, what the
person sees and can do when something goes wrong. The UI reads the host's
snapshots, but it is designed from the person's view, not from the host's slots:
one host field is not one piece of screen.

## Goals

- Something that cannot work is not offered. The person should rarely meet an
  error they could have been kept from.
- When something does fail, it shows **on the thing that failed**, and nothing else
  stops working.
- The screen never fills with text. A control's own state carries most of the
  meaning; words are a short label or a tooltip.
- Nothing moves when an error appears or clears. Nothing the person typed is lost.
  No toasts, no pop-ups they did not ask for.

## The conversation

- **A tool call fails.** Its card shows the failed state (icon and colour) and,
  when opened, its output. Tool calls running beside it carry on, and so does the
  reply.
- **A reply fails** (the model provider stopped it, timed out, ran out of credit).
  The reply ends with a failed marker and a short reason. The latest failed reply
  has Retry; earlier ones are just marked. The person can type and send as usual.
- **A message could not be sent.** The message stays in the conversation, dimmed,
  with Retry and Discard. Its text is never lost.

## The composer

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

## Controls in the session

- **Changing the model fails**: the model button stays on the previous model and
  shows a small failed mark; its tooltip says why. The session is otherwise
  unchanged.
- **Stop, compact, export, a command fails**: the result shows at that control (the
  button's state, the command's own output line), not as a session message.

## Session header and sidebar

- **The window loses its connection to the host**: the header shows
  "Reconnecting…" and the composer is dimmed. The session keeps running in the
  host and the window catches up on reconnect. This is not a session error.
- The sidebar row shows whether a session is running or has ended; nothing else.

## Settings

- **A settings action fails** (key rejected, sign-in failed): that card shows a
  short reason under the action that failed. Other cards keep working.
- **Several actions in a row**: each button shows its own progress while it waits
  its turn; nothing fails because another action is running.

## Start page

- **The app cannot work** (host unreachable, runtime not installed): the start page
  says so in one line with the one action that fixes it.

## Extensions and MCP

- **An MCP server needs attention** (for example sign-in): its entry in the MCP
  menu shows the state and the action. It is not shown in the conversation and is
  not repeated each time a runtime starts.

## Words on screen

- One short line at most. If a state needs more than a line to explain, the
  layout is changed instead.
- Original technical text is available under Details where it helps (copyable,
  never translated), and never as the main sentence. Advice that only works in a
  terminal ("Run /mcp") is never shown.
- Every label and line exists in en, ja, zh-Hans and zh-Hant.
- Fixed sizes: showing or clearing any of the above never moves the composer, the
  conversation or the sidebar, and long tokens (paths, model ids) never widen the
  window.

## Acceptance

- Two tool calls run in parallel and one fails: only its card shows it; the other
  completes; the reply continues; the composer is unchanged.
- Changing the model fails: the model button stays on the previous model with its
  failed mark; nothing else on screen changes; nothing is shown twice.
- A reply fails: the reply is marked; the next message sends normally.
- The session ends: the composer is replaced by the reason and one action; no
  other error appears for that session.
- A settings save fails while a catalog refresh runs: only that card shows it.
- With no model, Send cannot be pressed.
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
