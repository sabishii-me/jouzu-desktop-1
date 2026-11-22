import type { ActiveTurn } from "./chat-types";

/**
 * What the composer offers for the session on screen.
 *
 * - `stop`: a turn the host accepted is underway, or a message is on its way to
 *   it. Stop cancels either, including while the runtime is still starting.
 * - `steer`: the turn is past its startup, so a new message steers it (#179).
 * - `sending`: a message is on its way and the host has no turn for it yet.
 */
export function composerTurn(activeTurn: ActiveTurn | null | undefined, projectionRunning: boolean, submitting: boolean) {
  const steer = projectionRunning && activeTurn?.phase !== "starting";
  return { stop: projectionRunning || submitting, steer, sending: submitting && !steer };
}
