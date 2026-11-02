import { describe, expect, test, vi } from "vitest";
import type { JouzuApi } from "./api/jouzu-api";
import { HostChatTransport } from "./host-chat-transport";

function fakeApi() {
  let event: ((value: { id: number; event: string; data: Record<string, unknown> }) => void) | undefined;
  const api = {
    sessions: {
      attach: vi.fn(async () => ({ sessionId: "h1", workspacePath: "C:/w", sessionPath: null, status: "idle", cursor: 0 })),
      stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: "m-1", receipt: "queued" })),
      interrupt: vi.fn(async () => {}),
    },
    prompts: { approve: vi.fn(async () => {}), answer: vi.fn(async () => {}) },
    commands: { raw: vi.fn(async () => ({})) },
    subscribe: vi.fn((_session, _client, _caps, _cursor, callback) => {
      event = callback;
      return () => {};
    }),
  } as unknown as JouzuApi;
  return { api, emit: (value: Parameters<NonNullable<typeof event>>[0]) => event?.(value) };
}

describe("HostChatTransport", () => {
  test("queues raw runtime events and maps prompts/approvals", async () => {
    const { api, emit } = fakeApi();
    const transport = new HostChatTransport(api, "C:/w");
    const handle = await transport.start("C:/w");
    emit({ id: 1, event: "runtime.event", data: { type: "message_update", text: "hi" } });
    emit({ id: 2, event: "runtime.event", data: { type: "message_end" } });
    const batch = await transport.poll();
    expect(handle).toBe("h1");
    expect(batch.records).toHaveLength(2);
    expect(batch.closed).toBe(false);

    await transport.send("h1", { id: "p1", type: "prompt", message: "hello", images: [{ data: "AA==", mimeType: "image/png" }] });
    expect(api.sessions.send).toHaveBeenCalledWith("h1", {
      clientMessageId: "p1",
      text: "hello",
      attachments: [{ name: "image", mimeType: "image/png", data: "AA==" }],
    });

    await transport.send("h1", { id: "a1", type: "extension_ui_response", confirmed: true });
    expect(api.prompts.approve).toHaveBeenCalledWith("a1", "Approve");
    await transport.stop("h1");
    expect(api.sessions.stop).toHaveBeenCalledWith("h1");
  });
});
