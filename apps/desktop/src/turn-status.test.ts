import { describe, expect, it } from "vitest";
import { turnStopped } from "./turn-status";
import type { ChatMessage } from "./chat-projection";

const reply = (overrides: Partial<ChatMessage>): ChatMessage => ({ role: "assistant", content: [], ...overrides });

describe("turnStopped", () => {
  it("uses the host's last run outcome, not the shape of the last row", () => {
    // A stopped run whose reply never started has no aborted row, and no row at all.
    expect(turnStopped({ outcome: "stopped" }, undefined)).toBe(true);
    // A normal turn whose last visible step called tools is not a stopped turn.
    expect(turnStopped({ outcome: "completed" }, reply({ stopReason: "toolUse" }))).toBe(false);
    expect(turnStopped({ outcome: "completed" }, { role: "toolResult", content: [] })).toBe(false);
    // A completed run wins over an older aborted row.
    expect(turnStopped({ outcome: "completed" }, reply({ stopReason: "aborted" }))).toBe(false);
  });

  it("reads a saved transcript's own stop record when the host has no run yet", () => {
    expect(turnStopped(undefined, reply({ stopReason: "aborted" }))).toBe(true);
    expect(turnStopped(undefined, reply({ stopReason: "stop" }))).toBe(false);
    expect(turnStopped(undefined, reply({ stopReason: "toolUse" }))).toBe(false);
    expect(turnStopped(undefined, { role: "toolResult", content: [] })).toBe(false);
    expect(turnStopped(undefined, { role: "user", content: [] })).toBe(false);
  });
});