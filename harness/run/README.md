# Release test runner

Runs a release candidate's test plan and records what happened. It judges nothing
beyond each case's own checks, never stops early, and writes no conclusions.

| Script | What it does |
|---|---|
| `run-suite.mjs` | Suites A and B: the cases the plan selects from the case catalog (`release-checks/cases`, see its README), each in its own throwaway world, then 3 re-runs of every FAIL and ERROR. It refuses to start when the catalog and the code do not match. |
| `catalog.mjs` | Reads and checks the case catalog (`--check`), and writes the table people read (`--table`). |
| `record.mjs` | Suites C and D: records one acceptance item of the plan (PASS/FAIL, what was seen, evidence files). `--show <id>` prints its steps and expected results. |
| `report.mjs` | Writes `report.md` and `results.txt` from `results.jsonl`. Can be run again at any time; runs nothing. |
| `test/selftest.sh` | Tests the runner with a stand-in exam (pass, fail, hang, crash, skips, flaky, a process left behind). No app, no browser. |

## Rules the runner keeps

1. **One case, one world.** Each case runs `abnormal-exam.mjs` with `ABN_ONLY` set to that one
   case: its own home, host, browser, fixture provider and temp folder. A case that breaks the
   app cannot affect the next one.
2. **Nothing stops the run.** Every case has a time limit (`caseTimeoutMinutes` in the plan).
   Past it, everything the case started is stopped and the case is recorded as ERROR.
3. **Four results.** PASS; FAIL (the case's checks failed); ERROR (no verdict: time limit,
   crash, the world did not start, or the case skipped itself without a reason the plan
   declares); SKIP (only for a reason declared in the plan for that platform).
4. **Facts only.** Each result has the problems the case found, its notes, its evidence folder
   (screenshots, logs, `exam.log`) and the processes it left running. No field says "known",
   "not a regression" or "ignore".
5. **Re-runs last.** Only after every case ran once, each FAIL and ERROR runs again
   `reruns` times (default 3). Re-runs are recorded next to the first result and never replace it.
6. **Nothing is lost.** Each result is appended to `results.jsonl` when the case ends. Started
   again with the same `--out`, the runner continues after the last recorded case.
7. **Baseline by lookup.** `report.mjs` puts each result next to the last release's recorded
   result (`plan.baselines`) and states what the two say together: `REGRESSION` (baseline PASS,
   now FAIL/ERROR), `also fails in baseline`, `fixed since baseline`, `same`, `no baseline record`,
   or `N/A` (no release on this platform). Nothing is re-run to decide it.

## Run

```
# The app under test, as for abnormal-exam.mjs, e.g. an unpacked Windows package:
set ABN_HOST=R\pkg\jouzu-host.exe
set ABN_DIST=R\pkg\dist
set ABN_RUNTIME_APP=R\rt
node harness/run/run-suite.mjs --plan release-checks/<version>/plan.json --out R\out\<machine> --machine <machine> --langs en

# Acceptance items for this machine:
node harness/run/record.mjs --plan release-checks/<version>/plan.json --show D-mac-1
node harness/run/record.mjs --plan ... --out R\out\<machine> --machine <machine> --id D-mac-1 --result PASS --actual "..." --evidence accept\d-mac-1.png

# Report again after acceptance records or a triage file (<out>/triage.json: {"<lang>\t<case>" or "<item id>": {"issue": 123, "severity": "S2"}}):
node harness/run/report.mjs --out R\out\<machine> --plan release-checks/<version>/plan.json
```

The runner and the plan are frozen for a test round: the round names one commit of this
repository, and a fix to the runner or a case waits until the round is over.
