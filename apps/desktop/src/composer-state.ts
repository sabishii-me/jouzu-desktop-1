import type { ActiveTurn } from "./chat-types";

/** The composer can steer only after the host leaves its startup phase. */
export function composerRunningFor(activeTurn: ActiveTurn | null | undefined, projectionRunning: boolean) {
  return projectionRunning && activeTurn?.phase !== "starting";
}
