# Errors and notices

Status: draft v2 (2026-11-16), replaces the 2026-11-14 design implemented in
`9c2fd48`. Every new error path, and every fix that touches one, must follow it.

## Rules

1. **One type, one form.** Every message the app shows belongs to exactly one type
   (below). A type has one place, one look and one set of actions. The same
   underlying error never appears in two forms or two places.
2. **No stacking.** The notice area above the composer shows **one** notice at a
   time. A notice is not a queue and not a log.
3. **One error, one report.** An error is identified by its source and code. When
   several paths report the same error (for example a failed model change and the
   session error it caused), the user sees it once.
4. **Session messages appear only above the composer.** App messages appear where
   they happen (Settings card, update panel, start page, sidebar row).
5. **No floating toasts, no unexplained pop-ups.**
6. **Plain words on screen, original text in Details.** Details are collapsed,
   copyable, never translated, and the same text is written to `host.log` with its
   code.
7. **Never silent.** An action the user started either succeeds visibly or shows
   why it did not. Text the user typed is never lost.
8. **No notice for what the UI already shows** (an attachment in the composer, a
   new session opening). Stop is not an error.
9. **A notice never changes the layout.** The notice area has a fixed height
   (one line of text plus its actions). The sentence is cut with an ellipsis, long
   tokens (paths, model ids, URLs) wrap or are cut and never widen the window, and
   Details open in a bounded, scrollable panel over the conversation, not inside
   the flow. Showing, changing or clearing a notice moves nothing else: not the
   composer, not the transcript, not the sidebar. The same holds for App notices
   inside their card or panel.
10. **Every on-screen sentence and action label is localized** (en, ja, zh-Hans,
   zh-Hant) through the launcher's i18n catalog. No user-facing string is
   hard-coded in a component.

## Types

| Type | What it means | Where | Look | Actions | Clears when |
|---|---|---|---|---|---|
| **Blocked** | The session cannot continue until something is done | Notice area | Error | The one action that unblocks (Restart session, New session, Remove images, Clear Flow history, Open Settings) | The cause is gone; cannot be dismissed |
| **Action failed** | Something the user just did did not work | Notice area | Error | Retry | Retry succeeds, the next action, or Dismiss |
| **Reply failed** | The model or provider ended a reply with an error | Notice area for the latest reply; earlier replies only marked "failed" in the transcript | Error | Retry | Next turn starts, or Dismiss |
| **Not sent** | A message did not reach the runtime | The message stays in the composer (or is marked "not sent" in the transcript); reason in the notice area | Warning | Retry, Discard | Sent or discarded |
| **Needs a choice** | The runtime waits for the user (Flow hold, TextGuard review, approval) | Notice area, as the existing card for that feature | Warning | The feature's own choices | The choice is made |
| **Connection** | The window lost its link to the session | Notice area | Warning | Retry | Reconnected |
| **Information** | A result the UI cannot show by itself (export path, command reply) | Notice area | Info | Open folder / Dismiss | Next turn starts, or Dismiss |
| **Runtime notice** | Text the runtime or an extension sends (MCP status, extension errors) | Notice area | Warning or info | Dismiss | Dismiss; the same notice is not shown again for this session |
| **App** | Settings, provider, update, startup, folder runtime, panels | The card, panel or row where it happened | Error | Retry where it helps | The cause is gone |

Successes have no type of their own: the UI change is the confirmation (copy button
shows a check mark, a divider says "Earlier conversation compacted", the forked
session opens). Confirmations before destructive actions are not errors.

## One notice at a time

When more than one notice is due, only the highest is shown:

Blocked > Not sent > Reply failed > Action failed > Needs a choice > Connection >
Runtime notice > Information.

The others are not lost: when the shown notice clears, the next one is shown if it
still applies. Notices that no longer apply are dropped, not replayed.

## Sentences and i18n

- Each type and code maps to one catalog key, for example
  `notice.blocked.sessionStopped`, `notice.actionFailed.changeModel`,
  `notice.notSent.noModel`. Placeholders carry names, never raw error text.
- Host errors carry a `code`; the UI maps the code to a key. An unknown code uses
  the type's generic sentence ("The model was not changed.") and puts the original
  text in Details.
- Runtime and extension text cannot be translated by the launcher: the sentence is
  a localized summary ("An extension needs attention: slack (sign-in)"), the
  runtime's text goes to Details. Advice that only works in the terminal (for
  example "Run /mcp") is not shown as the sentence.
- A test fails the build when a notice, action label or composer hint is not in all
  four catalogs.

## Steer queue

Messages sent while a reply runs are not notices. They are listed above the
composer as the user's own pending messages, each removable or editable until the
runtime uses it. The host owns the queue and removes a message only after the
runtime confirms it used it; Stop takes unused ones back with Continue / Discard.

## Acceptance

- Trigger each type once: it appears only in its place, in its form, with no raw
  technical text on screen and the original in Details.
- Trigger two errors at once: one notice is shown; after it clears the other
  appears only if it still applies.
- Trigger one error through two paths (failed model change with a session error):
  it is shown once.
- Trigger the longest notice (image refused) and a notice with a long unbroken
  token, with Details open and closed, at the smallest window size: the composer,
  transcript and sidebar keep their size and position.
- Switch the interface language to each locale: every notice and action is
  translated; Details stay original.
- No toast component exists; no user action ends with no visible outcome.

## Known gaps in the current build (1.1.3-rc.2)

- Notices are rendered as a list, every source its own row: they stack and one
  error can be shown twice.
- All session notices, composer hints and `runtime-errors.ts` sentences are
  hard-coded English; only `App.tsx` and the web-access section use the i18n
  catalog.
- Settings shows a generic "Something went wrong" bar at the top of the window
  with raw text, not in the card that failed.
- Runtime notices (MCP status) are passed through verbatim, including terminal
  advice, and repeat on every runtime start.
- Notices grow with their text: long sentences, long tokens and opened Details
  push the composer up and can widen the layout.
- A message sent right after creating a session can disappear with no notice.
