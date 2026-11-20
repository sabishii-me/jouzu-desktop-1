---
name: accept-with-evidence
description: Decide whether a finished task really did what was asked.
---
# Accept with evidence

A task saying "done" is a claim. Accept it only on evidence you read in read_task:
- What changed: files, commits, branch, pull request link.
- What was run: the exact test or build command and its result (counts, not "tests pass").
- For a bug: the root cause, and a check that shows the problem is gone (the failing case now passes).
- For user-visible behaviour: how it was seen (a run, a screenshot, a log), not only that the code compiles.

If evidence is missing, ask the task for it with send_task (one message listing exactly what is missing). If evidence shows a problem, send it back with the problem quoted.

Report to the user: the outcome first, then the evidence in one or two lines, then anything left (follow-up issues, risks). Say plainly what you did not verify.
