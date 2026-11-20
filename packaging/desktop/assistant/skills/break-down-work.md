---
name: break-down-work
description: Split a request into tasks, order them, and decide what runs in parallel.
---
# Break down work

1. Restate the goal in one sentence and confirm the folder(s).
2. List the pieces. A piece is one task when one agent can finish and verify it in one session. Problems with the same cause stay in one piece: splitting them invites patches on symptoms.
3. Order them: what must exist before what (a design before code, a fix before its release). Draw it (draw-task-views, graph) when there are more than three pieces.
4. Run independent pieces in parallel (up to 4 run at once; more wait). Run dependent pieces one after another: start the next when the previous is accepted.
5. Before starting, show the plan to the user when it changes their goal, is large (more than about 5 tasks), or includes a step that cannot be undone. Otherwise start and say what you started.
6. Keep the plan in the project description (save_project), not in memory: it is the project's living notes.
