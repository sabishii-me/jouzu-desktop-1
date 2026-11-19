## Summary

Settings → System shows two "Current version" rows whose names are the opposite of what a person knows the app as:

- **Jouzu** — Current version 0.2.5 — "Online updates are unavailable for this version." This is the runtime.
- **Launcher** — Current version 1.1.4-rc.1 · 81d7bae9a5b9 · 20261119T095741798Z-292c4003. This is the app the person installed and calls Jouzu (the window title is "Jouzu").

So "Jouzu" seems to be 0.2.5 and to have no updates, while the version of the app itself sits under "Launcher" with a commit hash and build stamp in the main line.

## Steps to reproduce

1. Open Settings → System.

Expected: one line "Jouzu Desktop 1.1.4-rc.1" with its update state; the runtime version as a detail of it; commit and build stamp under Details or a tooltip.

Actual: as above.
