# 0026 — The sidebar lists workspaces by recency; none is pinned

Status: Proposed (this pull request; merging accepts it)
Date: 2026-11-24

## Context

The sidebar is a session list grouped by workspace. Groups are ordered by the most
recent session in each group, or by name when the user sorts by name. A group with no
sessions has no timestamp and sorts last.

The default workspace is a workspace like any other: the host creates
`~/Documents/Jouzu/default-workspace` on Windows and `~/Jouzu/default-workspace`
elsewhere, and uses it when a session has no folder chosen. The user does not pick it
as a favourite.

Issue #19 reports that with many workspaces the default workspace scrolls out of view,
and its "Expected behaviour" asks for it to stay visible without scrolling. Three
changes implemented that by pinning it: `c8b3d6b` (2026-11-09, "Fixes #19"), PR #225
(2026-11-22) and PR #245 (2026-11-24). `6063028` (2026-11-11) removed the pinned block
two days after `c8b3d6b`: "it is one more group at the bottom of the same list, as the
list always showed it". #225 was closed unmerged: "pinning the default workspace to the
bottom of the sidebar is a design change that was never approved … we don't think the
default workspace should be pinned." #19 stays open until its behaviour is decided.

## Decision

- The sidebar orders workspaces by the recency of their sessions. It reserves no space
  for any workspace and gives none a fixed position.
- The default workspace is not special in the sidebar: no pinned block, no forced
  position, and no promise that it is visible without scrolling. With many workspaces
  the list scrolls; that is the intended behaviour. In practice an unused default
  workspace sorts last because it has no session timestamp.
- Choosing a workspace is the workspace picker's job. The picker lists every workspace
  and marks the current one; it is on the new-session view. The app opens in the
  workspace that was last used.
- #19's acceptance criterion ("the default workspace stays visible without scrolling")
  is withdrawn. The issue is answered by this record, not by a layout change.

## Does not mean

- It does not remove the default workspace from the sidebar. It has a group like every
  other workspace, and its sessions open from that group.
- It does not give workspaces user-chosen pinning. Sessions can be pinned; workspaces
  cannot.
- It does not say the picker is sufficient today. From an open session the picker is
  not on screen; whether that gap is closed by the picker or by the group header is a
  separate question, and not a reason to pin one workspace.
- It does not decide how the UI learns which workspace is the default. It currently
  matches the folder name `default-workspace`, while the host reports the path; that is
  a separate defect about identity, not about order.
