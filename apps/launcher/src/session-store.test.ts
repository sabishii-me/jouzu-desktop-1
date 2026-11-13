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
    cancel: async () => {},
    queue: async () => {},
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

  it("keeps an accepted send in the transcript when the caller owns the pending row", async () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    await store.sendOrSteer("hello", [], false, "client-1", false);
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "hi" }], stopReason: "completed" }));
    expect(store.snapshot.projection.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  });

  it("puts the accepted user row before a reply that started first", async () => {
    let release: () => void = () => {};
    const session = fakeSession();
    const send = session.send;
    session.send = async message => { await new Promise<void>(resolve => { release = resolve; }); return send(message); };
    const store = SessionStore.attach(session);
    const pending = store.sendOrSteer("hello", [], false, "client-1", false);
    await new Promise(resolve => setTimeout(resolve, 2));
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.delta", { messageId: "m-1", text: "hi" }));
    release();
    await pending;
    session.emit(event(3, "message.delta", { messageId: "m-1", text: "!" }));
    const messages = store.snapshot.projection.messages;
    expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toEqual([{ type: "text", text: "hi!" }]);
  });

  it("keeps a reply with its own turn when a follow-up was accepted first", async () => {
    const session = fakeSession();
    let next = 0;
    session.send = async message => { session.sent.push(message); next += 1; return { messageId: `m-${next}`, receipt: "queued" }; };
    const store = SessionStore.attach(session);
    await store.sendOrSteer("one", [], false, "c-1", false);
    await store.sendOrSteer("two", [], true, "c-2", false);
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "a1" }], stopReason: "completed" }));
    session.emit(event(3, "message.start", { messageId: "m-2", turnId: "m-2", role: "assistant" }));
    session.emit(event(4, "message.done", { messageId: "m-2", blocks: [{ type: "text", text: "a2" }], stopReason: "completed" }));
    expect(store.snapshot.projection.messages.map(message => `${message.role}:${message.turnId}`)).toEqual(["user:m-1", "assistant:m-1", "user:m-2", "assistant:m-2"]);
  });

  it("disposes exactly once", () => {
    const onDispose = vi.fn();
    const store = SessionStore.attach(fakeSession(), onDispose);
    store.dispose();
    store.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });
});
