# Changelog

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
