import { describe, expect, it } from "vitest";
import { emptyProjection } from "./chat-projection";
import type { ChatSnapshot } from "./chat-types";
import { unusedNewSession } from "./new-session";

const blank = (patch: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  projection: emptyProjection(), connected: false, pending: false, connectionError: null, sessionId: "h-1", status: "starting", ...patch,
});

describe("unusedNewSession", () => {
  it("keeps a new session the host has, even while its runtime starts", () => {
    expect(unusedNewSession(blank())).toBe(true);
    expect(unusedNewSession(blank({ connected: true, status: "idle" }))).toBe(true);
  });

  it("does not keep a session something was sent in", () => {
    expect(unusedNewSession(blank({ pending: true }))).toBe(false);
    expect(unusedNewSession(blank({ projection: { ...emptyProjection(), messages: [{ role: "user", content: [] }] } as ChatSnapshot["projection"] }))).toBe(false);
    expect(unusedNewSession(blank({ outbox: [{ clientMessageId: "a", text: "hi", state: "sending" }] as ChatSnapshot["outbox"] }))).toBe(false);
    expect(unusedNewSession(blank({ queue: [{ clientMessageId: "a", text: "hi" }] as ChatSnapshot["queue"] }))).toBe(false);
  });

  it("does not keep a session that failed or that the host does not have", () => {
    expect(unusedNewSession(blank({ sessionId: undefined }))).toBe(false);
    expect(unusedNewSession(blank({ connectionError: "lost" }))).toBe(false);
    expect(unusedNewSession(blank({ failure: { code: "x", text: "y" } }))).toBe(false);
    expect(unusedNewSession(blank({ status: "stopped" }))).toBe(false);
  });
});
