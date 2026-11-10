import { afterEach, describe, expect, it, vi } from "vitest";
import { controlCancel, controlRequest } from "./control-client";

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

  it("posts the request and returns the adapter result", async () => {
    const fetch = answer(200, { schemaVersion: 1, models: [] });
    vi.stubGlobal("fetch", fetch);

    const value = await controlRequest({ action: "status" });

    expect(value).toEqual({ schemaVersion: 1, models: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/control");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "status" });
  });

  it("surfaces the host's message on failure", async () => {
    vi.stubGlobal("fetch", answer(409, { message: "Another configuration operation is running" }));

    await expect(controlRequest({ action: "status" })).rejects.toThrow(
      "Another configuration operation is running",
    );
  });

  it("falls back to a generic sentence for a non-json failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(controlRequest({ action: "status" })).rejects.toThrow(
      "The configuration service is unavailable.",
    );
  });

  it("cancels with and without a request id", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await controlCancel();
    await controlCancel("c-1");

    const bodies = fetch.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies).toEqual([{}, { requestId: "c-1" }]);
  });
});
