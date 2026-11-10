import { describe, expect, it } from "vitest";
import { clearPending, pendingFor, setPending } from "./pending-prompt";

describe("pending prompt ownership", () => {
  it("shows a pending prompt only in the session that submitted it", () => {
    const state = setPending({}, "session-a", "hello");
    expect(pendingFor(state, "session-a")).toBe("hello");
    expect(pendingFor(state, "session-b")).toBe("");
  });

  it("keeps a prompt that settles after the user switched session", () => {
    // A submits, the viewer moves to B, then A's send settles.
    let state = setPending({}, "session-a", "from a");
    state = setPending(state, "session-b", "from b");
    expect(pendingFor(state, "session-b")).toBe("from b");
    state = clearPending(state, "session-a");
    expect(pendingFor(state, "session-a")).toBe("");
    expect(pendingFor(state, "session-b")).toBe("from b");
  });

  it("does not touch other entries when the key is absent", () => {
    const state = setPending({}, "session-a", "hello");
    expect(clearPending(state, "session-missing")).toBe(state);
  });

  it("returns no prompt when no session is selected", () => {
    expect(pendingFor(setPending({}, "session-a", "hello"), "")).toBe("");
  });
});