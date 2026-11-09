import { describe, expect, it, vi, afterEach } from "vitest";
import { ChatConnection, flowNoticeText } from "./chat-connection";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
describe("desktop RPC connection", () => {
  it("moves Flow notices out of the banner and removes terminal instructions", () => {
    expect(flowNoticeText("Flow control paused after an interrupt. Automated work resumes on your next message. Run /flow for details."))
      .toBe("Flow control paused after an interrupt. Automated work resumes on your next message.");
    expect(flowNoticeText("Flow control is holding your message. Run /flow for the control that releases it."))
      .toBe("Flow control is holding your message.");
    expect(flowNoticeText("A normal extension notice.")).toBeUndefined();
  });
  it("keeps the chosen model when the user starts a new session", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const calls: string[] = [];
    const request = vi.spyOn(client, "request").mockImplementation(async (command: string, fields: Record<string, unknown> = {}) => {
      calls.push(command);
      if (command === "set_model") return { name: `${fields.provider}/${fields.modelId}` };
      if (command === "new_session") return { cancelled: false };
      if (command === "get_state") return { sessionId: "new", isStreaming: false, model: { name: "runtime-default", provider: "catalog", id: "default" } };
      if (command === "get_messages") return { messages: [] };
      return undefined;
    });
    await client.selectModel("catalog", "chosen");
    expect(client.snapshot.model).toBe("catalog/chosen");
    await client.newSession();
    expect(calls.filter(command => command === "set_model")).toHaveLength(2);
    expect(request).toHaveBeenLastCalledWith("set_model", { provider: "catalog", modelId: "chosen" });
    expect(client.snapshot.model).toBe("catalog/chosen");
  });
  it("accepts the released prompt success response without a disposition", async () => {    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    await client.sendOrSteer("hello", [], false);
    expect(request).toHaveBeenCalledWith("prompt", { message: "hello" });
    expect(client.snapshot.error).toBeNull();
    expect(client.snapshot.pending).toBe(false);
  });
  it("resumes live events after switching to a saved session", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    vi.spyOn(client, "request").mockImplementation(async (command: string) => {
      if (command === "switch_session") return { cancelled: false };
      if (command === "get_state") return { sessionId: "resumed", isStreaming: true, model: { name: "model", provider: "catalog", id: "model" } };
      if (command === "get_messages") return { messages: [] };
      return undefined;
    });
    await client.resumeSession("C:\\sessions\\resumed.jsonl");
    expect((client as unknown as { replaying: boolean }).replaying).toBe(false);
    expect(client.snapshot.pending).toBe(false);
  });
  it("runs an extension command without adding a user turn", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    await client.runCommand("/mcp");
    expect(request).toHaveBeenCalledWith("prompt", { message: "/mcp" });
    expect(client.snapshot.pending).toBe(false);
  });
  it("refuses to reload before the runtime has saved a session", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    await expect(client.reloadSession()).rejects.toThrow("no saved session");
  });
  it("loads session counters without treating them as chat failure", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    vi.spyOn(client, "request").mockResolvedValue({ userMessages: 3, toolCalls: 7, tokens: { total: 1234 }, contextUsage: { percent: 42 } });
    await client.loadStats();
    expect(client.snapshot.stats).toMatchObject({ userMessages: 3, toolCalls: 7, tokens: { total: 1234 }, contextUsage: { percent: 42 } });
    expect(client.snapshot.error).toBeNull();
  });
  it("accepts a Pi 1.0 prompt success that carries a disposition", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockResolvedValue({ disposition: "started" });
    await client.sendOrSteer("hello", [], false);
    expect(request).toHaveBeenCalledWith("prompt", { message: "hello" });
    expect(client.snapshot.error).toBeNull();
    expect(client.snapshot.pending).toBe(false);
  });
  it("steers while a run is active and prompts while idle", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockResolvedValue(undefined);
    await client.sendOrSteer("more", [], true);
    expect(request).toHaveBeenLastCalledWith("steer", { message: "more" });
    await client.sendOrSteer("next", [], false);
    expect(request).toHaveBeenLastCalledWith("prompt", { message: "next" });
  });
  it("forwards image content once and preserves caller data on rejection", async () => {
    const client = new ChatConnection(() => {}, () => {});
    const image = { type: "image" as const, mimeType: "image/png" as const, data: "aGVsbG8=" };
    const images = Object.freeze([Object.freeze(image)]);
    const request = vi.spyOn(client, "request").mockRejectedValue(new Error("rejected"));
    await expect(client.sendOrSteer("Inspect", images, false)).rejects.toThrow("rejected");
    expect(request).toHaveBeenCalledWith("prompt", { message: "Inspect", images });
    expect(images[0]).toEqual(image);
    expect(client.snapshot.pending).toBe(false);
  });
  it("compacts and exports through the released runtime commands", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockImplementation(async (command: string) => {
      if (command === "get_state") return { sessionId: "compact-id", isStreaming: false, model: { name: "model", provider: "catalog", id: "model" } };
      if (command === "get_messages") return { messages: [] };
      if (command === "export_html") return { path: "C:\\tmp\\chat.html" };
      return undefined;
    });
    await client.compact();
    expect(request).toHaveBeenCalledWith("compact");
    // A full history refresh after compact can exceed the JSONL frame limit.
    expect(request).not.toHaveBeenCalledWith("get_messages");
    expect(client.snapshot.pending).toBe(false);
    await client.exportHtml("C:\\tmp\\chat.html");
    expect(request).toHaveBeenLastCalledWith("export_html", { outputPath: "C:\\tmp\\chat.html" });
  });
  it("attaches for compact without fetching the transcript", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockImplementation(async (command: string) => {
      if (command === "get_state") return { sessionId: "big", sessionFile: "C:/sessions/big.jsonl", isStreaming: false, model: { name: "model", provider: "catalog", id: "model" } };
      if (command === "get_messages") throw new Error("JSONL frame exceeds 33554432 bytes");
      return undefined;
    });
    await client.compactSession("C:/sessions/big.jsonl");
    expect(request).toHaveBeenCalledWith("switch_session", { sessionPath: "C:/sessions/big.jsonl" });
    expect(request).toHaveBeenCalledWith("compact");
    expect(request).not.toHaveBeenCalledWith("get_messages");
    expect(client.snapshot.sessionFile).toBe("C:/sessions/big.jsonl");
  });
  it("reads a large session through the native tail instead of get_messages", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request").mockImplementation(async (command: string) => {
      if (command === "get_state") return { sessionId: "big", sessionFile: "C:/sessions/big.jsonl", isStreaming: false, model: { name: "model", provider: "catalog", id: "model" } };
      if (command === "get_messages") throw new Error("JSONL frame exceeds 33554432 bytes");
      return undefined;
    });
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "chat_session_bytes") return 25 * 1024 * 1024;
      if (command === "chat_session_messages") return [{ role: "user", content: [{ type: "text", text: "recent" }] }];
      return undefined;
    });

    await client.refreshHistory();

    expect(request).not.toHaveBeenCalledWith("get_messages");
    expect(client.snapshot.projection.messages.at(-1)?.content[0]?.text).toBe("recent");
  });
  it("prepends the previous native page and stops at the beginning", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = {
      ...client.snapshot,
      connected: true,
      sessionFile: "C:/sessions/big.jsonl",
      historyLimited: true,
      projection: { ...client.snapshot.projection, messages: [{ role: "user", content: [{ type: "text", text: "newer" }] }] },
    };
    vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
      if (command !== "chat_session_messages") return undefined;
      if (args?.before === 1) return [{ role: "user", content: [{ type: "text", text: "older" }] }];
      return [];
    });

    expect(await client.loadEarlier()).toBe(1);
    expect(client.snapshot.projection.messages.map(message => message.content[0]?.text)).toEqual(["older", "newer"]);
    expect(await client.loadEarlier(200)).toBe(0);
    expect(client.snapshot.historyLimited).toBe(false);
  });
  it("waits out a long released-runtime cold start", async () => {
    vi.useFakeTimers();
    const requests: Record<string, unknown>[] = [];
    const replied = new Set<unknown>();
    const startedAt = Date.now();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "chat_start") return "cold" as never;
      if (command === "chat_send") { requests.push((args as { request: Record<string, unknown> }).request); return undefined as never; }
      if (command === "chat_poll") {
        if (Date.now() - startedAt < 60_000) return { records: [], closed: false } as never;
        const request = requests.find(item => ["get_state", "get_messages"].includes(String(item.type)) && !replied.has(item.id));
        if (request) { replied.add(request.id); return { records: [{ type: "response", id: request.id, command: request.type, success: true, data: request.type === "get_state" ? { sessionId: "cold-id", isStreaming: false } : { messages: [] } }], closed: false } as never; }
        return { records: [], closed: false } as never;
      }
      return undefined as never;
    });
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await vi.advanceTimersByTimeAsync(61_000);
    await starting;
    expect(client.snapshot.connected).toBe(true);
    expect(client.snapshot.error).toBeNull();
    await client.close();
  });
  it("does not project replayed history while a saved session opens", async () => {
    vi.useFakeTimers();
    const requests: Record<string, unknown>[] = [];
    const replied = new Set<unknown>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "chat_start") return "saved" as never;
      if (command === "chat_send") { requests.push((args as { request: Record<string, unknown> }).request); return undefined as never; }
      if (command === "chat_poll") {
        const request = requests.find(item => ["get_state", "get_messages"].includes(String(item.type)) && !replied.has(item.id));
        if (!request) return { records: [], closed: false } as never;
        replied.add(request.id);
        const response = { type: "response", id: request.id, command: request.type, success: true, data: request.type === "get_state" ? { sessionId: "saved-id", isStreaming: false } : { messages: [] } };
        const replayed = request.type === "get_state" ? [{ type: "message_start", message: { role: "user", content: "old prompt" } }, { type: "message_end", message: { role: "user", content: "old prompt" } }] : [];
        return { records: [...replayed, response], closed: false } as never;
      }
      return undefined as never;
    });
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(client.snapshot.connected).toBe(true);
    expect(client.snapshot.projection.messages).toHaveLength(0);
    await client.close();
  });
  it("reports an unanswered request after the watchdog without replaying it", async () => {
    vi.useFakeTimers();
    const requests: Record<string, unknown>[] = [];
    const replied = new Set<unknown>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "chat_start") return "h" as never;
      if (command === "chat_send") { requests.push((args as { request: Record<string, unknown> }).request); return undefined as never; }
      if (command === "chat_poll") {
        const request = requests.find(item => ["get_state", "get_messages"].includes(String(item.type)) && !replied.has(item.id));
        if (request) { replied.add(request.id); return { records: [{ type: "response", id: request.id, command: request.type, success: true, data: request.type === "get_state" ? { sessionId: "runtime-id", isStreaming: false } : { messages: [] } }], closed: false } as never; }
        return { records: [], closed: false } as never;
      }
      return undefined as never;
    });
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(client.snapshot.connected).toBe(true);
    const sending = client.sendOrSteer("one prompt", [], false).catch(error => error);
    await vi.advanceTimersByTimeAsync(301_000);
    expect(await sending).toBeInstanceOf(Error);
    expect(client.snapshot.connected).toBe(false);
    expect(requests.filter(request => request.type === "prompt")).toHaveLength(1);
    await client.close();
  });
  it("keeps startup dialogs answerable without charging user time to the watchdog", async () => {
    vi.useFakeTimers();
    const requests: Record<string, unknown>[] = [];
    let emitted = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "chat_start") return "startup" as never;
      if (command === "chat_send") { requests.push((args as { request: Record<string, unknown> }).request); return undefined as never; }
      if (command === "chat_poll") {
        if (!emitted) { emitted = true; return { records: [{ type: "extension_ui_request", id: "confirm-start", method: "confirm", title: "Continue?" }], closed: false } as never; }
        return { records: [], closed: false } as never;
      }
      return undefined as never;
    });
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.snapshot.transportReady).toBe(true);
    expect(client.snapshot.connected).toBe(false);
    expect(client.snapshot.error).toBeNull();
    await client.reply("confirm-start", { confirmed: false });
    expect(requests.some(request => request.type === "extension_ui_response")).toBe(true);
    await client.close();
    await starting;
  });
  it("keeps history when session switching is cancelled and refreshes after any success", async () => {
    const client = new ChatConnection(() => {}, () => {});
    client.snapshot = { ...client.snapshot, connected: true };
    const request = vi.spyOn(client, "request");
    request.mockResolvedValueOnce({ cancelled: true });
    await expect(client.resumeSession("C:\\sessions\\saved.jsonl")).rejects.toThrow("cancelled");
    expect(request).toHaveBeenCalledTimes(1);
    // A released success may omit its data entirely; the desktop still refreshes authoritative state.
    request.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ sessionId: "saved", sessionFile: "saved.jsonl", isStreaming: false }).mockResolvedValueOnce({ messages: [{ role: "user", content: "saved prompt" }] });
    await client.newSession();
    expect(client.snapshot.sessionId).toBe("saved");
    expect(client.snapshot.projection.messages[0].content[0].text).toBe("saved prompt");
    expect(client.snapshot.pending).toBe(false);
  });
  it("rejects replies after disposal", async () => {
    const client = new ChatConnection(() => {}, () => {});
    await client.close();
    await expect(client.reply("dialog", { confirmed: true })).rejects.toThrow("not connected");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("closes a late startup after view disposal", async () => {
    let finish!: (value: string) => void;
    vi.mocked(invoke).mockImplementation(command => command === "chat_start" ? new Promise(resolve => { finish = resolve as (value: string) => void; }) : Promise.resolve(undefined as never));
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await client.close(); finish("late"); await starting;
    expect(invoke).toHaveBeenCalledWith("chat_stop", { handle: "late" });
    expect(invoke).not.toHaveBeenCalledWith("chat_poll", expect.anything());
  });
});

  it("keeps polling after a stale extension context error", async () => {
    vi.useFakeTimers();
    const requests: Record<string, unknown>[] = [];
    const replied = new Set<unknown>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "chat_start") return "stale" as never;
      if (command === "chat_send") { requests.push((args as { request: Record<string, unknown> }).request); return undefined as never; }
      if (command === "chat_poll") {
        const request = requests.find(item => ["get_state", "get_messages"].includes(String(item.type)) && !replied.has(item.id));
        if (!request) return { records: [], closed: false } as never;
        replied.add(request.id);
        const stale = { type: "extension_error", extensionPath: "<inline:test>", error: "This extension ctx is stale after session replacement or reload." };
        const response = { type: "response", id: request.id, command: request.type, success: true, data: request.type === "get_state" ? { sessionId: "stale-id", isStreaming: false } : { messages: [] } };
        return { records: [stale, response], closed: false } as never;
      }
      return undefined as never;
    });
    const client = new ChatConnection(() => {}, () => {});
    const starting = client.start("folder");
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(client.snapshot.connected).toBe(true);
    await client.close();
  });
