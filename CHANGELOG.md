# Changelog

## 1.0.23 - 2026-11-09

- Restore the session open path to the 2570a2d behaviour: a 4 MB tail preview
  read once, and an authoritative runtime transcript. The desktop-side pager,
  the 256 MB scan and the 20 MB native fallback are gone.
- A transcript above the 32 MiB frame limit is reported as a per-session error
  with a retry instead of dropping the session offline.
- The turn summary reports files created by shell commands, not only by edit
  tools, and renders them as cards instead of collapsing the whole turn.
- Settings blocks the view behind it while it is open.
- Workspace groups stay collapsed once the user collapses them.

## 1.0.11 - 2026-11-03

- Retry the model catalog after a fresh sign-in. The first catalog refresh can
  race a just-issued account key; the chat now retries it instead of leaving a
  signed-in install with an empty model list. If all attempts fail, the model
  menu and the Shisa.AI card in Settings offer an explicit retry.

## 1.0.10 - 2026-11-02

- Fix compact on a large session: the desktop no longer reads the whole
  transcript to attach for compact or after it, so a response above the 32 MiB
  JSONL frame limit can no longer close the session. Compaction changes the
  runtime context; the view keeps the transcript it already has.

## 1.0.9 - 2026-11-02

- Add Codex OAuth to Add Provider: sign in with a ChatGPT Plus/Pro account
  using the same device-code flow as Shisa.AI.

## 1.0.8 - 2026-11-02

- Fix the first-run runtime install: npm lifecycle scripts now find the Node
  that the installer just downloaded, so a machine without a system Node can
  finish provisioning.

## 1.0.1 - 2026-10-23

- Ship the desktop-only installer; the Jouzu runtime is provisioned separately.
- Update the app from the desktop update feed.
- Show the TextGuard review prompt above the composer.
- Add fork, pin and archive session actions.
- Reconcile interrupted tool calls when a session is reopened.

## 0.2.1 - 2026-10-21

- Prepare the standalone desktop product.
- Keep desktop identity independent from the launcher.

## 0.2.0 - 2026-10-20

- Add the Windows launcher with the embedded chat workspace.

