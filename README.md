# Jouzu Desktop QA

Independent QA for Jouzu Desktop. This repository holds the harness that puts
the app in each UI state, and the **UI atlas**: every state of every version
as a screenshot plus the words on screen, so a version's UI can be audited
without installing or opening it. Nothing here ships to users, and the
product repository holds no images.

This repository is public. Screenshots come only from fixture data: a fake
model provider and a throwaway home, never a real account or data folder.
`tools/scan-public.mjs` must pass before every commit. Security problems are
never reported here; they go to the maintainers privately.

Only QA and the maintainers merge here. People and agents who write the
product's code do not change baselines or verdicts in this repository. The
product repository keeps its accessible names and test ids stable; the
scenarios that use them live here.

## Layout

| Path | What it is |
|---|---|
| `harness/e2e-runtime/abnormal-exam.mjs` | Runs a playbook against a throwaway home with a world it can break and repair (provider faults, runtime kills, slow starts, bad files). Never touches a real data folder; only stops processes it started. |
| `harness/e2e-runtime/fixture-server.mjs` | Deterministic local model provider with switchable faults (401/404/429/500, dropped connection, hang). |
| `harness/e2e/ui-states.mjs` | The UI state tour: records each screen in the states a person meets. Judges nothing. |
| `harness/e2e/abnormal-playbook.mjs` | Abnormal-path cases, judged against the error rules (never silent, own scope, once, no layout shift, no endless wait, plain words, nothing lost, recovers). |
| `harness/e2e/playbook-report.mjs` | HTML + JSON report of playbook runs. |
| `tools/atlas-build.mjs` | Adds one run's states to `atlas/` for a version. |
| `tools/atlas-diff.mjs` | Lists states that appeared, disappeared, look or say something different between two versions. |
| `tools/scan-public.mjs` | Checks files about to be committed for keys, tokens, personal folders and private names. |
| `viewer/index.html` | Open from disk to browse a version or compare two. |
| `atlas/blobs/` | Screenshots stored once by SHA-256 (Git LFS). |
| `atlas/versions/<version>/index.json` | Each state of that version: id, language, device, theme, image, words. |

## Record a version

Run on the test machine only, never on a personal computer or against a real
data folder.

```
npm install
# Installed app, as a person starts it (Windows):
set ABN_SHELL=C:\Program Files\Jouzu Desktop\Jouzu Desktop.exe
set ABN_PLAYBOOK=ui-states.mjs
set ABN_LANGS=en,ja
set ABN_OUT=runs\1.1.5-dev.x
node harness\e2e-runtime\abnormal-exam.mjs
node tools\atlas-build.mjs --version 1.1.5-dev.x --run runs\1.1.5-dev.x --device desktop-1280 --theme dark --source "installed app"
```

`abnormal-exam.mjs` also runs the installed package's host and UI in a test
browser (`ABN_INSTALL`, `ABN_MANAGED`) or a source build (`ABN_HOST`,
`ABN_DIST`, `ABN_RUNTIME_APP`); see the top of the file.

## Compare two versions

```
node tools/atlas-diff.mjs 1.1.4 1.1.5-rc.1 --json runs/diff.json
```

Every change it lists must be marked **intended** (name the issue or PR) or a
**regression**. An unmarked change or a regression blocks the release. The
marking is done by QA, not by whoever wrote the change.

## Viewer

Open `viewer/index.html` from disk. Pick a version, optionally a version to
compare with, and the language, device and theme. "Only changed" shows the
states that differ, older image first.

## State of this repository

The harness was written against the 1.1.3/1.1.4 UI (148 states, en/ja,
desktop 1280 wide). It has not yet been run against the current develop UI;
some states may need their steps updated. Devices other than the desktop
window (web on desktop, iPad, phone), themes other than the default, and
states the tour does not reach yet are still to be added. See `AGENTS.md`.
