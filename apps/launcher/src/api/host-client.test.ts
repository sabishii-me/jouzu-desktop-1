import { describe, expect, test } from "vitest";
import { HostClient } from "./host-client";
import { ApiError } from "./jouzu-api";

type Call = { url: string; init?: RequestInit };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HostClient", () => {
  test("merges live and persisted sessions with canonical dedupe", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/sessions")) {
        return response({ sessions: [{ sessionId: "h1", workspacePath: "C:/w", sessionPath: "C:/s/one.jsonl", title: "one", status: "idle", running: false }] });
      }
      if (String(input).endsWith("/v1/sessions/persisted")) {
        return response({ sessions: [{ sessionId: null, workspacePath: "C:/w", sessionPath: "C:/s/one.jsonl", title: "one", status: "stopped", running: false }, { sessionId: null, workspacePath: "C:/w2", sessionPath: "C:/s/two.jsonl", title: "two", status: "stopped", running: false }] });
      }
      return response({});
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    const sessions = await client.sessions();
    expect(sessions).toHaveLength(2);
    expect(calls.map(call => call.url)).toEqual(["http://host/v1/sessions", "http://host/v1/sessions/persisted"]);
  });

  test("sends attachments and a client id", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return response({ messageId: "m-1", receipt: "queued" }, 202);
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "", clientId: "web-test", fetchImpl });
    await client.send("h1", "hello", "c-1", [{ name: "a.png", mimeType: "image/png", data: "AA==" }]);
    expect(body).toEqual({
      clientMessageId: "c-1",
      text: "hello",
      clientId: "web-test",
      attachments: [{ name: "a.png", mimeType: "image/png", data: "AA==" }],
    });
  });

  test("unwraps command data and maps error envelopes", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/sessions/h1/command")) {
        return response({ data: { models: [] } });
      }
      return response({ error: { code: "prompt-resolved", message: "already", retryable: false } }, 409);
    }) as typeof fetch;
    const client = new HostClient({ fetchImpl });
    await expect(client.command("h1", { type: "get_available_models" })).resolves.toEqual({ models: [] });
    await expect(client.approve("a1", "Approve")).rejects.toMatchObject<Partial<ApiError>>({
      code: "prompt-resolved",
      retryable: false,
      status: 409,
    });
  });
});
