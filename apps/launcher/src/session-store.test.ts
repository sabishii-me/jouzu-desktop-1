import { describe, expect, it, vi } from "vitest";
import { SessionStore, type SessionPort } from "./session-store";
import type { ApiEvent, HistoryPage } from "./api/jouzu-api";

function fakeSession(): SessionPort & { emit: (event: ApiEvent) => void; sent: unknown[]; stopped: boolean } {
  let listener: ((event: ApiEvent) => void) | undefined;
  const sent: unknown[] = [];
  const session = {
    id: "s-test",
    sent,
    stopped: false,
    history: async (): Promise<HistoryPage> => ({
      messages: [
        { cursor: 1, id: "u1", kind: "user", text: "hello", createdAt: "2026-11-12T00:00:00.000Z", blocks: [{ type: "text", text: "hello" }] },
      ],
      nextBefore: null,
    }) as unknown as HistoryPage,
    send: async (message: unknown) => {
      sent.push(message);
      return { messageId: "m-1", receipt: "queued" };
    },
    interrupt: async () => {},
    stop: async () => { session.stopped = true; },
    detach: () => { listener = undefined; },
    follow: (onEvent: (event: ApiEvent) => void) => { listener = onEvent; },
    emit: (event: ApiEvent) => listener?.(event),
  };
  return session;
}

const event = (id: number, name: string, data: Record<string, unknown>): ApiEvent => ({ id, event: name, data: { ...data, sessionId: "s-test" } });

describe("SessionStore", () => {
  it("loads host history and projects normalized blocks", async () => {
    const store = SessionStore.attach(fakeSession());
    await store.loadHistory();
    expect(store.snapshot.connected).toBe(true);
    expect(store.snapshot.projection.messages[0].content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("follows message and tool events without raw runtime records", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.delta", { messageId: "m-1", text: "hi" }));
    session.emit(event(3, "message.delta", { messageId: "m-1", text: "!", kind: "thinking" }));
    session.emit(event(4, "tool.start", { toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }));
    session.emit(event(5, "tool.result", { toolCallId: "call-1", ok: true, result: { output: "x" } }));
    session.emit(event(6, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "hi" }], stopReason: "completed" }));

    const projection = store.snapshot.projection;
    expect(projection.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
    expect(projection.tools["call-1"]).toMatchObject({ phase: "complete", name: "bash" });
    expect(projection.running).toBe(false);
  });

  it("marks a queued send pending and clears it on done", async () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    await store.send("hello", [], "client-1");
    expect(session.sent).toEqual([{ clientMessageId: "client-1", text: "hello", attachments: [] }]);
    expect(store.snapshot.pending).toBe(true);
    session.emit(event(1, "message.done", { messageId: "m-1", blocks: [], stopReason: "completed" }));
    expect(store.snapshot.pending).toBe(false);
  });

  it("disposes exactly once", () => {
    const onDispose = vi.fn();
    const store = SessionStore.attach(fakeSession(), onDispose);
    store.dispose();
    store.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });
});
