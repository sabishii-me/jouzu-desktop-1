import { describe, expect, it, vi } from "vitest";
import { eventRouter } from "./event-router";
import type { HostClient } from "./api/host-client";
import type { ApiEvent } from "./api/jouzu-api";

describe("event router", () => {
  it("delivers global events and advances the resume sequence", () => {
    let emit: ((event: ApiEvent) => void) | undefined;
    const subscribeEvents = vi.fn((_clientId: string, _after: number, onEvent: (event: ApiEvent) => void) => {
      emit = onEvent;
      return () => {};
    });
    eventRouter.start({ clientId: "router-test", subscribeEvents } as unknown as HostClient);
    const seen: ApiEvent[] = [];
    const unsubscribe = eventRouter.subscribe(event => seen.push(event));
    emit?.({ id: 7, seq: 7, sessionId: "s1", event: "session.updated", data: { status: "idle" } });
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe("s1");
    unsubscribe();
  });
});
