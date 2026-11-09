/**
 * A prompt that the runtime accepted but has not settled yet belongs to the session
 * that accepted it. It is keyed by that session so switching the visible session can
 * never show it, and settling it can never clear another session's entry.
 */
export type PendingBySession = Readonly<Record<string, string>>;

export function setPending(current: PendingBySession, key: string, text: string): PendingBySession {
  return { ...current, [key]: text };
}

export function clearPending(current: PendingBySession, key: string): PendingBySession {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

/** The pending prompt the given session owns, or an empty string. */
export function pendingFor(current: PendingBySession, key: string): string {
  return key ? current[key] ?? "" : "";
}