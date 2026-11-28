# Jouzu Desktop QA

Independent QA for Jouzu Desktop. This repository holds:

- the **case catalog**: every test case once, in YAML, with a permanent ID
  (`release-checks/cases/`, read `CASES.md`);
- the **release test runner** that runs a release candidate's cases one by one,
  each in its own throwaway world, and records PASS / FAIL / ERROR / SKIP
  (`harness/run/`);
- the **playbooks**: the code of each case (`harness/e2e/`), and the world they
  run in (`harness/e2e-runtime/`);
- the **UI atlas** tools: every state of a version as a screenshot plus the
  words on screen (`tools/atlas-*.mjs`, `harness/e2e/ui-states.mjs`).

Nothing here ships to users, and the product repository holds no images.

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
| `release-checks/cases/*.yaml` | The case catalog: one entry per case (ISO/IEC/IEEE 29119-3 fields). Its README says what each field means. |
| `release-checks/cases/CASES.md` | The table people read, generated from the YAML (`npm run catalog:table`). Never edited by hand. |
| `release-checks/<version>/plan.json` | One test round's frozen plan: which cases, time limits, re-runs, declared skips, baselines. |
| `release-checks/baselines/<version>/` | The recorded per-case results of a release, used as the regression baseline. |
| `release-checks/1.1.5-rc.2/close-comments/` | The evidence comments written when issues were closed after 1.1.5-rc.2. |
| `harness/run/run-suite.mjs` | The runner: takes the plan's cases from the catalog, runs each in its own world, re-runs FAIL and ERROR at the end, writes `results.jsonl`. |
| `harness/run/catalog.mjs` | Checks the catalog against the code (`npm run catalog:check`) and writes `CASES.md`. |
| `harness/run/record.mjs` | Records an acceptance item that is checked by hand. |
| `harness/run/file-issues.mjs` | Files every product FAIL of a run as a GitHub issue, deduplicated (one issue per finding; comments on an issue that already has it; never reopens a closed one). |
| `harness/run/report.mjs` | Writes `report.md` and `results.txt` from `results.jsonl`, with the baseline comparison. |
| `harness/run/common.mjs` | Shared helpers of the runner scripts. |
| `harness/run/test/` | The runner's self-test (`selftest.sh`): a stand-in exam, no app. |
| `harness/e2e-runtime/abnormal-exam.mjs` | Starts one world: a throwaway home, the app's host, a test browser, the fixture provider, and a control server the cases use to break and repair it (provider faults, runtime kills, slow starts, bad files, restarts, quitting). Never touches a real data folder; only stops processes it started. |
| `harness/e2e-runtime/fixture-server.mjs` | Deterministic local model provider with switchable faults, scripted replies (LONG, TOOL, TOOLWAIT, STEPS:n, PHASES, BULK, FULL) and a Shisa.AI sign-in stand-in. |
| `harness/e2e-runtime/app-window.mjs` | The installed app on macOS/Linux started as a person starts it, on a throwaway home: its window driven over WebKitWebDriver (Linux), its tray Quit clicked over its session bus (INST cases). |
| `harness/e2e-runtime/update-world.mjs` | The Windows update world: the earlier version installed by its installer into a throwaway folder (`/S /NS /D=`), with throwaway data and profile folders, then updated in the app (UPD cases). The machine's own Jouzu Desktop is never moved or closed. |
| `harness/e2e-runtime/runtime-delay.mjs` | Loaded into runtimes the world starts, to make a runtime slow to start on request. |
| `harness/e2e/playbook-kit.mjs` | What every playbook shares: the words of the interface per language, locators, waiting, and the judgements (silent, scope, recovery). |
| `harness/e2e/release-playbook.mjs` | The release playbook's cases (main user paths, smoke). |
| `harness/e2e/update-playbook.mjs` | The in-app update cases (UPD-*), Windows; attaches to the app's window again after each update. |
| `harness/e2e/abnormal-playbook.mjs` | Abnormal-path and regression cases, judged against the error rules (never silent, own scope, once, no layout shift, no endless wait, plain words, nothing lost, recovers). |
| `harness/e2e/host-timing.mjs` | The host's own share of a reply, read from `host.log` (the host gate, #129). |
| `harness/e2e/playbook-report.mjs` | HTML + JSON report of one playbook run started without the runner, with the host gate. |
| `harness/e2e/ui-states.mjs` | The UI state tour for the atlas: records each screen in the states a person meets. Judges nothing. |
| `tools/atlas-build.mjs` | Adds one run's states to `atlas/` for a version (`atlas/` is created by it; it is not in the repository yet). |
| `tools/atlas-diff.mjs` | Lists states that appeared, disappeared, look or say something different between two versions. |
| `tools/scan-public.mjs` | Checks files about to be committed for keys, tokens, personal folders and private names. |

## Run a release candidate's cases

On a test machine only, as a normal user (the runner refuses an administrator),
never against a real data folder.

```
npm install
npm run catalog:check
# The app under test (see the top of harness/e2e-runtime/abnormal-exam.mjs), then:
node harness/run/run-suite.mjs --plan release-checks/<version>/plan.json --out <out> --machine <machine> --langs en,ja
```

What each world needs besides the app under test:

| Cases | Platforms | Needs |
|---|---|---|
| INST-002/003/004 (world installed-package) | Linux, macOS | `ABN_APP` = the installed app's executable; `ABN_APP_SEED` = a managed folder an earlier run of that app installed its runtime into. Linux also needs `xvfb`, `dbus` and `webkit2gtk-driver` (WebKitWebDriver). |
| UPD-* (world installed-app) | Windows | `ABN_UPDATE_FROM_RELEASE` and `ABN_UPDATE_FROM_RC` = the earlier installers, `ABN_UPDATE_TO` = the version under test. |
| IMG-001/002 | all | The QA accounts' credentials `JOUZU_QA_SHISA_KEY`, `JOUZU_QA_SHISA_FREE_KEY`, `JOUZU_QA_CHATGPT_AUTH`. Until a QA credential store exists these steps are a harness gap and record ERROR. |

Disk: each case's world lives under `<out>/cases/<lang>/<case>/tmp` and is
deleted when the case ends, also after a FAIL, ERROR or crash. Only small
evidence files (logs, JSON, text, at most 1 MB each and 20 MB per case) are kept
in `<case>/kept/`. Before every case the runner checks the disk: if the run's
folder holds more than `diskCapMB` (plan, default 2000) or the disk has less
than `minFreeMB` free (plan, default 5000), the run stops at once with exit
code 3, prints why, and the report marks the cases not started as NOT RUN.

Issues: at the end of every run the runner files each product FAIL as an issue in
the product repository (`harness/run/file-issues.mjs`, `plan.issueRepo`), with no
review step first. One issue per finding: an issue that names the case ID and
describes the same failure (open ones first), or else the issue the catalog
links, gets a comment (a closed one is never reopened by the filer: it is listed in `issues.json` for people to decide); otherwise a new issue
is opened, naming any issue of the same case that describes another failure. Filing the same run twice adds
nothing. ERROR results are harness gaps and are listed, not filed. It needs a
GitHub sign-in that may write issues (`GH_TOKEN`, or `gh` signed in); without
one the run ends with exit code 4 and `issue-actions.json` holds what to file.
`--no-issues` turns it off. To file a run recorded elsewhere:
`node harness/run/file-issues.mjs --out <folder with results.jsonl and run.json>`.

`harness/run/README.md` has the runner's rules, acceptance records and the report.
To add or change a case: edit its YAML entry and its code together, then
`npm run catalog:check` and `npm run catalog:table`.

## Record a version for the atlas

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

## State of the atlas

The atlas viewer is not in this repository yet. The state tour was written against the 1.1.3/1.1.4 UI (148 states, en/ja,
desktop 1280 wide). It has not yet been run against the current develop UI;
some states may need their steps updated. Devices other than the desktop
window (web on desktop, iPad, phone), themes other than the default, and
states the tour does not reach yet are still to be added. See `AGENTS.md`.
