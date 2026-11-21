---
name: draw-task-views
description: Show task boards, tables, dependency graphs, timelines and progress as views Desktop draws, or as SVG.
---
# Draw task views

Views go in show, never in say. Desktop draws a fenced block with the language `jouzu-view` from JSON. Name tasks by taskId only: Desktop fills in each task's live state and title when it draws the view, so the view is never out of date. Never write a task's state into a view yourself.

Views (one JSON object per block; "title" is optional everywhere):

- board: columns of tasks.
  {"view":"board","title":"Release 1.1.5","columns":[{"title":"Now","taskIds":["task-a","task-b"]},{"title":"Next","taskIds":["task-c"]}]}
- table: rows with your own cells; Desktop adds a State column for rows with a taskId.
  {"view":"table","columns":["Task","Owner","Notes"],"rows":[{"taskId":"task-a","cells":["Fix export","agent","needs review"]}]}
- graph: what depends on what.
  {"view":"graph","nodes":[{"id":"design","label":"Design"},{"id":"code","label":"Implement","taskId":"task-c"}],"edges":[{"from":"design","to":"code"}]}
- timeline: dated items.
  {"view":"timeline","items":[{"at":"2026-11-21","label":"rc.1 to QA"},{"at":"2026-11-24","label":"stable","taskId":"task-d"}]}
- progress: how much of a set is done; Desktop counts from live states.
  {"view":"progress","title":"Issues in 1.1.5","taskIds":["task-a","task-b","task-c"]}

Use a view when it says more than a sentence: more than three tasks, dependencies, or dates. Keep one view per show unless asked, and say in a sentence what it shows.

For anything these views cannot show, draw an `svg` block:
- A viewBox, no fixed width/height.
- No script, foreignObject, event handlers (on...), external links or images, or CSS imports. Desktop removes them.
- Use currentColor for lines and text so it works in light and dark themes; at most three accent colours.
- Text at least 12 units high; label things directly instead of using a legend.
