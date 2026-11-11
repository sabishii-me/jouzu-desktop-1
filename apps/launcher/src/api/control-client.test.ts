import { afterEach, describe, expect, it, vi } from "vitest";
import { configureControlClient, controlCancel, controlRequest } from "./control-client";
import { HostClient } from "./host-client";

/** Control now runs through the configured client, so the tests drive that client. */
function useClient(fetchImpl: ReturnType<typeof vi.fn>, token = "test-token") {
  configureControlClient(
    new HostClient({ baseUrl: "http://host", token, fetchImpl: fetchImpl as unknown as typeof fetch }),
  );
  return fetchImpl;
}

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("control client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the request with the host token", async () => {
    const fetch = useClient(answer(200, { schemaVersion: 1, models: [] }));

    const value = await controlRequest({ action: "status" });

    expect(value).toEqual({ schemaVersion: 1, models: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://host/v1/control");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init.body))).toEqual({ action: "status" });
  });

  it("surfaces the host's message on failure", async () => {
    useClient(answer(409, { error: { code: "control-busy", message: "Another configuration operation is running" } }));

    await expect(controlRequest({ action: "status" })).rejects.toThrow(
      "Another configuration operation is running",
    );
  });

  it("falls back to a generic sentence for a non-json failure", async () => {
    useClient(vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(controlRequest({ action: "status" })).rejects.toThrow(
      "Host request failed (500)",
    );
  });

  it("cancels with and without a request id", async () => {
    const fetch = useClient(vi.fn(async () => new Response(null, { status: 204 })));

    await controlCancel();
    await controlCancel("c-1");

    const bodies = fetch.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies).toEqual([{}, { requestId: "c-1" }]);
  });
});
