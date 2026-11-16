# Errors and notices

Status: draft v3 (2026-11-16), for discussion. Replaces v2 (one notice at a time
above the composer) and the 2026-11-14 design implemented in `9c2fd48`. Every new
error path, and every fix that touches one, must follow it.

## Principles

1. **An error belongs to a scope: the thing it interrupts.** A failed tool call
   interrupts that tool call, a failed reply interrupts that reply, a failed save
   interrupts that save. The scope decides where the error is kept, where it is
   shown and when it clears.
2. **An error changes only its own scope.** It moves up a level only when the
   level above is really broken (for example the runtime exited and could not be
   recovered), and the host makes that decision in one place. Operations in
   different scopes never block or fail each other.
3. **An error is shown where its scope lives**, not in a shared list. There is no
   error queue: each place holds at most one current error, and errors of
   different scopes never compete for the same place.
4. **A session-level error means one thing: the session was ended by an error.**
   A session has at most one. It is not a notice: it is the session's state, and
   the composer is replaced by the reason and the one action that recovers.
5. **The host owns the error; the UI renders it.** Runtime events and runtime text
   reach the host only. The host classifies them, removes duplicates and exposes
   each error in the scope's slot of its snapshot (`SessionView`, `AppView`). The
   UI does not parse runtime text or keep its own copy of session errors.
6. **The host never trusts its caller; the UI removes illegal paths.** Every host
   command checks its preconditions and refuses with a typed code. The UI uses
   layout and the state of its controls so that a user cannot start something
   that must fail (no model: Send is unavailable). Text is used only where the
   design cannot carry the state, and kept to a word or a tooltip.
7. **Never silent, never noisy.** An action the user started either succeeds
   visibly or shows why it did not, in its own place. Text the user typed is never
   lost. No floating toasts, no unexplained pop-ups, no screens of explanatory text.

## Scopes

| Scope | Interrupts | Does not affect | Kept in (host) | Shown | Clears |
|---|---|---|---|---|---|
| Tool call | That tool call | Other tool calls in parallel, the reply, the session | `tool.result` with `ok: false` | That tool's card in the transcript | Never; it is history |
| Message | That message (not delivered) | The session, a running reply, other messages | `queue[].error`; before it reaches the host, the UI outbox | That message: "not sent", Retry / Discard; its text is kept | Sent or discarded |
| Reply (run) | That reply (provider error, timeout, quota) | The session stays usable | `lastRun.error`, and the reply's record | That reply, marked failed with Retry on the latest one | Stays in history; Retry only on the latest |
| Operation in a session | That action (change model, compact, export, command, Stop) | Session state, the reply, the current model | The command's response code | Next to the control that started it | The next action |
| Session | The session cannot continue (runtime failed and recovery failed, handshake refused, a refused image in history, Flow history full) | Other sessions, settings | `failure` (`lifecycle = failed`), set only by `Session::fail` | The composer is replaced by the reason and the one recovery action | After that action |
| Connection | This window's link to the host | Sessions keep running in the host; reconnect resumes from the last sequence | UI only (only it can see it) | Session header state ("Reconnecting…") | Reconnected |
| Settings operation | That one operation (save key, sign in) | Other operations, all sessions | `AppView.config.lastResult` | That settings card | The next operation of that kind |
| App | The app cannot work (host unreachable, runtime not installed) | — | `AppView.startup` | Start page | The cause is gone |
| Information | Nothing (MCP server needs sign-in, extension status) | — | The feature it belongs to, deduplicated per session | That feature (for example the MCP menu entry of that server) | Resolved or dismissed; not repeated for the same session |

Successes have no notice: the UI change is the confirmation. Confirmations before
destructive actions are not errors. Stop is not an error.

## Precondition and runtime errors

Every host error code is one of two kinds:

- **Precondition**: the command could not work in the current state (no model,
  session ended, text over the limit, too many images, model without image input,
  command while a reply runs). The UI should have made this path unavailable. If a
  user sees one without a race, the UI missed a path; the host logs
  `ui.illegal_path` with the code so it can be found.
- **Runtime**: a real failure that could not be known in advance (tool failed,
  provider error, runtime crash, network, invalid key, a model removed from the
  catalog at the moment of sending). Shown in its scope.

Whether and how an error can be retried is decided per API and per error, not by
a blanket rule. Retry is offered only where it can succeed.

## Cascades

Several errors at once mean one failure caused others. When a scope escalates (for
example the session ends), errors of lower scopes caused by it are not reported
again: the host writes `notice.cascade` to `host.log` with both codes, and the
cascade is fixed at its source so that, after a failure, actions that cannot work
in the new state are not attempted.

## Layout

An error never changes the layout. The place an error appears in has a fixed size;
sentences are cut with an ellipsis; long tokens (paths, model ids, URLs) wrap or
are cut and never widen the window; Details open in a bounded, scrollable panel
over the content, not inside the flow. Showing or clearing an error moves nothing
else: not the composer, the transcript or the sidebar.

## Text and i18n

- Plain words on screen, original text in Details. Details are collapsed,
  copyable, never translated, and the same text is written to `host.log` with its
  code.
- The host sends a code and parameters; the UI maps the code to a catalog key
  (en, ja, zh-Hans, zh-Hant). An unknown code uses its scope's generic sentence and
  puts the original text in Details.
- Runtime and extension text cannot be translated by the launcher: the sentence is
  a localized summary, the runtime's text goes to Details. Advice that only works
  in a terminal (for example "Run /mcp") is never the sentence.
- A test fails the build when a sentence or action label is missing from any of
  the four catalogs.

## Steer queue

Messages sent while a reply runs are not errors. They are listed above the composer
as the user's own pending messages, each removable or editable until the runtime
uses it. The host owns the queue and removes a message only after the runtime
confirms it used it; Stop takes unused ones back with Continue / Discard.

## Acceptance

- Two tool calls run in parallel and one fails: the failure shows only on its card,
  the other completes, the reply continues, nothing appears above the composer.
- Changing the model fails: the reason shows at the model control; the session
  state and the current model do not change; nothing is reported twice.
- A reply fails: it is marked on that reply; the next message can be sent.
- The session ends (runtime killed and recovery refused): the composer is replaced
  by the reason and one recovery action; no other error is shown for that session;
  `host.log` has the `notice.cascade` entries.
- A settings save fails while a catalog refresh runs: only that card shows the
  error; the refresh completes.
- With no model available, Send is unavailable; the host refuses a direct API send
  with `no-model`.
- The longest error text and a long unbroken token, Details open and closed, at
  the smallest window size: composer, transcript and sidebar keep size and position.
- Every sentence and action exists in all four locales; Details stay original.
- No toast component exists; no user action ends with no visible outcome.

## Known gaps in the current build (1.1.3-rc.2)

- Session notices are built in the UI from fourteen inputs and shown as one list
  above the composer: they stack, and one failure can appear twice (model change
  failure reported as a session notice and as the command's error).
- Operation failures (Stop, queue actions) are written into the session-wide error
  field and shown as session errors.
- A dropped event stream marks the session disconnected with a session error.
- One settings operation running makes every other one, including status reads,
  fail with `control-busy`.
- Runtime notices (MCP status) are passed through verbatim, including terminal
  advice, and repeat on every runtime start.
- Session notices, composer hints and `runtime-errors.ts` sentences are hard-coded
  English.
- Notices grow with their text and push the composer.
- A message sent right after creating a session can disappear with no visible
  outcome, because Send is available before the session has a model.
