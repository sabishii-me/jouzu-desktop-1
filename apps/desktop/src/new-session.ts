import type { ChatSnapshot } from "./chat-types";

/**
 * Whether the session on screen is already a new session nobody has used: the
 * host has it, nothing was sent in it and nothing went wrong. New session then
 * keeps it instead of starting another, so the runtime it already has (often
 * the one the app warmed while starting) is not thrown away and the next
 * session does not wait for a runtime of its own (decision 0016).
 */
export function unusedNewSession(snapshot: ChatSnapshot): boolean {
  if (!snapshot.sessionId) return false;
  if (snapshot.connectionError || snapshot.failure || snapshot.historyError) return false;
  if (snapshot.status === "stopped" || snapshot.status === "error") return false;
  if (snapshot.pending || snapshot.activeTurn || snapshot.projection.running) return false;
  if (snapshot.projection.messages.length) return false;
  if (snapshot.outbox?.length || snapshot.queue?.length || snapshot.prompts?.length || snapshot.failedTurn) return false;
  return true;
}
