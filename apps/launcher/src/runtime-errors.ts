/**
 * Runtime errors that a user cannot act on must never reach the screen verbatim.
 * The runtime's Flow submission store is per session and never reclaimed, so a
 * capacity failure can only be answered by starting a new session.
 */
export const CAPACITY_MESSAGE = "This session has used up its stored message budget, so it cannot accept another message. Start a new session to keep working.";

export function isCapacityError(message: string | null | undefined): boolean {
  return !!message && /Submission retention limit reached/iu.test(message);
}

/** Flow's per-session submission store is full; `/flow clear` is the recovery. */
export function isFlowHistoryError(message: string | null | undefined): boolean {
  return !!message && /Request history is full/iu.test(message);
}

export function humanizeRuntimeError(message: string): string {
  return isCapacityError(message) ? CAPACITY_MESSAGE : message;
}
