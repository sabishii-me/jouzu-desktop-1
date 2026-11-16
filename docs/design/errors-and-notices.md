# Errors and notices

Status: approved 2026-11-14, implemented in `9c2fd48`. Open decision at the end.

This document is the rule set for how Jouzu Desktop shows errors, warnings and
information. Every new error path, and every fix that touches one, must follow it.

## Rules

1. **Session errors and notices appear only above the composer**, in the session
   notice area, in one form.
2. **App errors appear where they happen**: settings errors in Settings, update
   errors in the update panel, startup errors on the start page, a folder's errors
   on that folder's row in the sidebar.
3. **No floating toasts.** A toast leaves its context, disappears, and does not say
   which session it belongs to.
4. **No raw technical errors on screen.** The user sees one plain sentence and the
   actions they can take. The original text goes into an expandable **Details**
   section and into `host.log`.
5. **No notice for a result the UI already shows** (for example, an attachment
   that already appears in the composer).

## The one form

Every notice above the composer has the same parts:

- one sentence that says what happened, in plain words;
- the actions that help (Retry, New session, Restart session, Remove images, ...);
- **Details**, collapsed by default, with the original error text (copyable);
- Dismiss, unless dismissing would leave the session silently unusable.

Implementation: `apps/launcher/src/session-alerts.ts` (what is shown) and
`apps/launcher/src/session-alerts-view.tsx` (how it is shown).

## Order

Notices are ordered by what the user must deal with first:

1. Failures that block every message (session cannot open, session stopped,
   too many open sessions, Flow history full, model rejects an image).
2. Things that need a choice (Flow holds a message, TextGuard review, approvals,
   unsent messages).
3. Information (command results, export done).

## Where each notice goes

### Inside a session (above the composer)

| Situation | Sentence (shape) | Actions |
|---|---|---|
| Runtime or extension error | "Extension X failed; this reply may be incomplete." | Details, Dismiss |
| Session cannot open | "This session could not be opened: reason." | Retry, New session |
| Session stopped | "This session stopped and needs a restart." | Restart session |
| Too many open sessions | "Too many sessions are open at once." | New session |
| Flow request history full | "Flow request history is full. Clear it before sending again." | Clear Flow history |
| Model rejects an image | "The model rejected a request because of an image in this conversation ..." | Remove images |
| Reply failed | "The last reply stopped because the model returned an error." | Retry |
| Message not sent | The message is only marked "not sent"; reason and actions are here | Retry, Discard |
| No model selected | "Choose a model before sending." Model picker highlighted | Choose model |
| Changing model / thinking level failed | "The model was not changed: reason." Picker returns to the old value | Retry |
| Compact, fork, export, reload, recover failed | "Compacting did not finish: reason." (etc.) | Retry |
| Attachment / video link error | Plain sentence | Dismiss |
| Runtime command reply (e.g. TextGuard) | Info line; clears when the next turn starts | Dismiss |
| Connection lost | "Lost the connection to this session." | Retry |
| Approval error | Stays in the approval card, which is itself in this area | - |

### Successes

Successes get no separate notice when the UI already shows them:

| Result | How the user sees it |
|---|---|
| Session ID copied | The copy button shows a check mark for 2 s |
| Files added | They appear in the composer |
| Compacted | A divider in the conversation: "Earlier conversation compacted" |
| Forked | The new session opens |
| Reloaded | Nothing |
| Exported | Info line "Exported to ..." with "Open folder" |
| Session recovered | A divider in the conversation |

### App level

| Source | Where |
|---|---|
| Settings, provider connection, startup | In the card where it failed |
| Window minimise/close failed | Log only (the user cannot act on it) |
| A folder's runtime cannot start | Under that folder in the sidebar, with Retry |
| Rename session | Inline on the sidebar row; failure shown on that row |
| Update check / install | In the update panel, plain sentence + Details |
| Files, tools, artifacts, MCP, components, reports panels | In the panel, plain sentence + Details |

Confirmations (delete, stop and switch) keep the system confirm dialog; they are
not errors.

## Plain sentence and Details

- Every error the host returns has a `code`. The UI maps the code to a sentence,
  for example `capacity` -> "Too many sessions are open at once."
- An unknown code: say which step did not succeed ("The model was not changed"),
  and put the original text in Details.
- Details are collapsed by default and copyable, for bug reports. `host.log` holds
  the same text.

## Steer queue

- Messages sent while a reply is running are listed above the composer as an
  ordered queue. Each can be removed or edited until the runtime uses it.
- The host owns the queue. It hands a message to the runtime as `steer`; the
  runtime inserts it at the next safe point (after the current step's tools,
  before the next model request). A message leaves the queue only after the
  runtime confirms it used it, so reconnecting or switching sessions neither
  loses nor duplicates it.
- Stop takes unused messages back from the runtime. They stay in the queue with
  Continue or Discard.

## Acceptance

- Trigger each error once: it appears only where this document says, no raw
  technical text is on screen, and Details holds the original.
- The UI has no toast component.
- Steer: send 3 messages during a long reply; the queue shows them in order and
  each is inserted once, in order. Reconnecting, or switching away and back, loses
  or duplicates nothing. After Stop the rest can be continued or discarded.

## Open decision (2026-11-16)

Observed on 1.1.3-rc.1/rc.2: several notices stack above the composer at once,
and one failure can be reported twice from two paths (for example a session
error and "Could not change the model" with the same Details). The current
implementation renders every source as its own row, with no de-duplication and no
limit, and recent fixes added more notice kinds.

Proposed rule, pending approval:

- Show **one** notice at a time: the most important one by the order above. Others
  wait and appear when it is resolved or dismissed.
- **One underlying error is reported once**, whichever path reported it.
