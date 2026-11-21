import type { ChatMessage } from "./chat-projection";
import type { LastRun } from "./chat-types";

/**
 * The last turn was stopped by the person (#214). The host's `lastRun` is that
 * fact. A saved transcript shown before the host opens its session has no host
 * run to ask, so its reply row's own record (`stopReason: "aborted"`) is read
 * instead; a tool-using step or a tool result is not a stopped turn.
 */
export function turnStopped(lastRun: LastRun | null | undefined, lastMessage: ChatMessage | undefined): boolean {
  if (lastRun) return lastRun.outcome === "stopped";
  return lastMessage?.role === "assistant" && lastMessage.stopReason === "aborted";
}