/**
 * How the sidebar arranges its sessions. Grouping, order and filter are the
 * user's choice (docs/decisions/0026-sidebar-arrangement-is-the-users-choice.md);
 * the rules live here, away from the view, so each one can be checked alone.
 */
export type GroupBy = "workspace" | "tree" | "one-list";
export type OrderBy = "manual" | "updated";
export type SessionFilter = "hide-archived" | "all" | "archived-only";

export interface Arrangement {
  groupBy: GroupBy;
  orderBy: OrderBy;
  filter: SessionFilter;
}

/** The user's own order: workspace ids, then session keys, first to last. */
export interface ManualOrder {
  groups: string[];
  sessions: string[];
}

export const DEFAULT_ARRANGEMENT: Arrangement = { groupBy: "workspace", orderBy: "updated", filter: "hide-archived" };
export const EMPTY_MANUAL: ManualOrder = { groups: [], sessions: [] };

const ARRANGEMENT_KEY = "jouzu.ui.sidebar.arrangement";
const MANUAL_KEY = "jouzu.ui.sidebar.manual-order";

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;
type Store = ReadStore & WriteStore;

const defaultStore = (): Store | null => typeof localStorage === "undefined" ? null : localStorage;

/** One spelling of a folder, whatever case or separator reached it (#239). */
export function pathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

const GROUP_BY: readonly GroupBy[] = ["workspace", "tree", "one-list"];
const ORDER_BY: readonly OrderBy[] = ["manual", "updated"];
const FILTERS: readonly SessionFilter[] = ["hide-archived", "all", "archived-only"];

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? value as T : fallback;

export function loadArrangement(store: ReadStore | null = defaultStore()): Arrangement {
  if (!store) return { ...DEFAULT_ARRANGEMENT };
  try {
    const parsed: unknown = JSON.parse(store.getItem(ARRANGEMENT_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_ARRANGEMENT };
    const value = parsed as Record<string, unknown>;
    return {
      groupBy: oneOf(GROUP_BY, value.groupBy, DEFAULT_ARRANGEMENT.groupBy),
      orderBy: oneOf(ORDER_BY, value.orderBy, DEFAULT_ARRANGEMENT.orderBy),
      filter: oneOf(FILTERS, value.filter, DEFAULT_ARRANGEMENT.filter),
    };
  } catch {
    return { ...DEFAULT_ARRANGEMENT };
  }
}

export function saveArrangement(next: Arrangement, store: WriteStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(ARRANGEMENT_KEY, JSON.stringify(next));
  } catch {
    /* A webview without storage keeps the choice for this session only. */
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function loadManualOrder(store: ReadStore | null = defaultStore()): ManualOrder {
  if (!store) return { ...EMPTY_MANUAL };
  try {
    const parsed: unknown = JSON.parse(store.getItem(MANUAL_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_MANUAL };
    const value = parsed as Record<string, unknown>;
    return { groups: [...new Set(strings(value.groups))], sessions: [...new Set(strings(value.sessions))] };
  } catch {
    return { ...EMPTY_MANUAL };
  }
}

export function saveManualOrder(next: ManualOrder, store: WriteStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(MANUAL_KEY, JSON.stringify(next));
  } catch {
    /* Same as above: the order holds for this session. */
  }
}

/** What the rules need from a session, and nothing else. */
export interface ArrangementSession {
  path: string;
  workspace: string;
  title: string;
  updated: number;
  archived?: boolean;
}

export interface ArrangementWorkspace {
  id: string;
  path: string;
}

export interface SidebarGroup<T extends ArrangementSession = ArrangementSession> {
  /** The workspace's path key: one group per folder, whatever spelling reached it. */
  id: string;
  path: string;
  name: string;
  /** How far the group is nested in `tree`; always 0 otherwise. */
  depth: number;
  sessions: T[];
}

export interface SidebarModel<T extends ArrangementSession = ArrangementSession> {
  /** `list` is the one-list grouping: no groups, every session in one list. */
  mode: "groups" | "list";
  groups: SidebarGroup<T>[];
  sessions: T[];
}

export interface BuildInput<T extends ArrangementSession = ArrangementSession> {
  workspaces: readonly ArrangementWorkspace[];
  sessions: readonly T[];
  arrangement: Arrangement;
  manual: ManualOrder;
  query: string;
  /** The workspace's display name; the view localises it. */
  label: (path: string) => string;
}

const keptBy = (filter: SessionFilter) => (session: ArrangementSession): boolean =>
  filter === "all" ? true : filter === "archived-only" ? session.archived === true : session.archived !== true;

/**
 * The order of a list: the user's when they chose one, otherwise newest first.
 * Keys the user's order does not know yet keep their recency position at the
 * end, so a new session arrives at the bottom of a list the user arranged.
 */
function order(keys: readonly string[], manual: readonly string[] | null, rank: (key: string) => number): string[] {
  if (!manual) return [...keys].sort((left, right) => rank(right) - rank(left));
  const present = new Set(keys);
  const head = manual.filter(key => present.has(key));
  const seen = new Set(head);
  const rest = keys.filter(key => !seen.has(key)).sort((left, right) => rank(right) - rank(left));
  return [...head, ...rest];
}

/** Newest session in the list, or 0 for a workspace with none. */
const newest = (sessions: readonly ArrangementSession[]): number =>
  sessions.reduce((latest, session) => Math.max(latest, session.updated), 0);

export function buildSidebar<T extends ArrangementSession>({ workspaces, sessions, arrangement, manual, query, label }: BuildInput<T>): SidebarModel<T> {
  const needle = query.trim().toLowerCase();
  const manualGroups = arrangement.orderBy === "manual" ? manual.groups : null;
  const manualSessions = arrangement.orderBy === "manual" ? manual.sessions : null;
  const kept = sessions.filter(keptBy(arrangement.filter));
  const byWorkspace = new Map<string, T[]>();
  const paths = new Map<string, string>();
  for (const workspace of workspaces) {
    byWorkspace.set(pathKey(workspace.path), []);
    paths.set(pathKey(workspace.path), workspace.path);
  }
  for (const session of kept) {
    const key = pathKey(session.workspace);
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    if (!paths.has(key)) paths.set(key, session.workspace);
    byWorkspace.get(key)!.push(session);
  }
  const nameOf = (key: string) => label(paths.get(key) ?? key);
  const matchesGroup = (key: string) => !!needle && (nameOf(key).toLowerCase().includes(needle) || (paths.get(key) ?? "").toLowerCase().includes(needle));

  if (arrangement.groupBy === "one-list") {
    const rows = kept.filter(session => !needle
      || session.title.toLowerCase().includes(needle)
      || session.workspace.toLowerCase().includes(needle)
      || nameOf(pathKey(session.workspace)).toLowerCase().includes(needle));
    const keys = rows.map(session => pathKey(session.path));
    const byKey = new Map(rows.map(session => [pathKey(session.path), session]));
    const rank = (key: string) => byKey.get(key)?.updated ?? 0;
    return { mode: "list", groups: [], sessions: order(keys, manualSessions, rank).map(key => byKey.get(key)!) };
  }

  const groups: SidebarGroup<T>[] = [];
  for (const [key, list] of byWorkspace) {
    const sessionsHere = matchesGroup(key) ? list : list.filter(session => session.title.toLowerCase().includes(needle));
    if (needle && !matchesGroup(key) && !sessionsHere.length) continue;
    const keys = sessionsHere.map(session => pathKey(session.path));
    const byKey = new Map(sessionsHere.map(session => [pathKey(session.path), session]));
    const rank = (sessionKey: string) => byKey.get(sessionKey)?.updated ?? 0;
    groups.push({
      id: key,
      path: paths.get(key) ?? key,
      name: nameOf(key),
      depth: 0,
      sessions: order(keys, manualSessions, rank).map(sessionKey => byKey.get(sessionKey)!),
    });
  }
  const groupRank = new Map(groups.map(group => [group.id, newest(group.sessions)]));
  const groupOrder = order(groups.map(group => group.id), manualGroups, key => groupRank.get(key) ?? 0);
  const byId = new Map(groups.map(group => [group.id, group]));

  if (arrangement.groupBy === "workspace") {
    return { mode: "groups", groups: groupOrder.map(id => byId.get(id)!), sessions: [] };
  }

  // `tree`: a workspace whose folder sits inside another workspace's folder is
  // nested under it; siblings keep the same order as the flat list.
  const parentOf = (key: string): string | null => {
    let best: string | null = null;
    for (const candidate of byId.keys()) {
      if (candidate === key || !key.startsWith(`${candidate}/`)) continue;
      if (!best || candidate.length > best.length) best = candidate;
    }
    return best;
  };
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const key of groupOrder) {
    const parent = parentOf(key);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), key]);
    else roots.push(key);
  }
  const nested: SidebarGroup<T>[] = [];
  const visit = (key: string, depth: number) => {
    nested.push({ ...byId.get(key)!, depth });
    for (const child of children.get(key) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return { mode: "groups", groups: nested, sessions: [] };
}

/** The user's order as the current view shows it, used when they switch to Manual. */
export function manualFromModel(model: SidebarModel<ArrangementSession>): ManualOrder {
  return {
    groups: model.groups.map(group => group.id),
    sessions: model.mode === "list"
      ? model.sessions.map(session => pathKey(session.path))
      : model.groups.flatMap(group => group.sessions.map(session => pathKey(session.path))),
  };
}

/**
 * Moves `key` one place up or down inside `scope` (the list on screen), keeping
 * every other entry where it is. The ends are no-ops.
 */
export function moveWithin(manual: readonly string[], key: string, delta: -1 | 1, scope: readonly string[]): string[] {
  const index = scope.indexOf(key);
  if (index < 0) return [...manual];
  const target = scope[index + delta];
  if (target === undefined) return [...manual];
  const next = manual.filter(entry => entry !== key);
  const at = next.indexOf(target);
  if (at < 0) return [...manual];
  next.splice(delta > 0 ? at + 1 : at, 0, key);
  return next;
}

/** Puts `key` immediately before `target`, for a drop on that row. */
export function moveBefore(manual: readonly string[], key: string, target: string): string[] {
  if (key === target) return [...manual];
  const next = manual.filter(entry => entry !== key);
  const at = next.indexOf(target);
  if (at < 0) return [...manual];
  next.splice(at, 0, key);
  return next;
}
