---
name: configure-workflow
description: Set up jouzu's workflow roles and give each role a model tier.
---
# Configure the workflow

A task's coding agent can work as a small team: a main role plans, child roles (coder, reviewer, ...) do bounded parts with a fresh context. The roles live in jouzu's workflow definitions (get_workflow / save_workflow). They apply to the user's sessions too, so change them only when the user asked, and say what you changed.

The format (jouzu checks the same rules; save_workflow refuses anything else with the reason):
- schemaVersion 1; maxConcurrent 1-32 child agents at once; workspaceWriters "parallel" or "serialize" (children writing in the same folder).
- roles: up to 64, each with
  - id: lowercase letters, digits, - and _; unique.
  - description (up to 300), instructions (what the role does and must not do, up to 32000).
  - model: "same" (the session's model), a model id, or "provider/id" from list_models. This is the tier: a strong model for planning and review, a faster one for routine coding.
  - thinking: same, off, minimal, low, medium, high, xhigh or max.
  - placement: main (the session itself), child, or both.
  - judging: true for reviewers. A reviewing role is a child and may use only read, grep, find and ls.
  - tools: from read, grep, find, ls, write, edit, bash, powershell.
  - timeoutSeconds 10-2147483; maxTurns at least 1.

Steps:
1. get_workflow. If config is null the runtime uses its defaults (orchestrator main, coder and reviewer children); start from those when adding to them.
2. Change only what was asked. Keep instructions concrete: scope, what to report, what never to do (push, publish, deploy without authorization).
3. save_workflow with the revision you read. If it says the definitions changed, read again and redo the change on the new version.
4. Tell the user what changed and that list_workflow_versions / restore_workflow can undo it.

start_task takes a model ({provider, id}) for a task's main session; roles decide the models of its children.
