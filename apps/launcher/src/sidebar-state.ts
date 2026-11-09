/**
 * Which workspace groups the user opened. The list is keyed by workspace id and
 * persisted, so a remount, a session switch or a restart never opens a group on its
 * own: only an explicit toggle changes the set, and the default is closed.
 */
const KEY = "jouzu.ui.expanded-workspaces";

export function loadExpanded(store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveExpanded(next: Set<string>, store: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* A webview without storage keeps the choice for this session only. */
  }
}

export function toggleExpanded(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}