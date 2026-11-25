# 0027 — The sidebar has one arrangement menu

Status: Accepted
Date: 2026-11-24

## Context

[0026](0026-sidebar-arrangement-is-the-users-choice.md) decided that grouping, order
and filter are the user's choice, and said each setting becomes a menu on its control.
Grouping had no control, so the first implementation added one: a fifth icon beside
search, archive, sort and add folder.

That header is not the one the sidebar is drawn from: search, one arrangement control
and add folder. A fifth 28px icon crowds the title, and it invents a second place to
look for a setting that belongs with the other two.

## Decision

- The header keeps three controls: search, the arrangement control, and add folder.
- The arrangement control opens one menu with three labelled sections — `Group by`,
  `Order by`, `Filter sessions` — each holding its choices and marking the active one.
- The archive and sort toggles fold into that menu. They are no longer separate
  controls, and the menu is always present.

## Does not mean

- [0026](0026-sidebar-arrangement-is-the-users-choice.md)'s rules stand unchanged: the
  three settings and their choices, the defaults (workspace, last update, hidden), the
  client-side preference, and no pinned or otherwise privileged workspace.
- It does not hide the arrangement control when nothing is archived. That rule existed
  for a control that held the archive filter alone.
- It does not move the arrangement into the host, and it does not add a per-workspace
  pin.
