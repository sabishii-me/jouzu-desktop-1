import { afterEach, describe, expect, it, vi } from "vitest";
import { eventRouter } from "./event-router";
import type { HostClient } from "./api/host-client";
import type { ApiEvent } from "./api/jouzu-api";
import { configureModelCatalog, modelCatalog, parseCatalog } from "./model-catalog";

const view = (revision: number, ids: string[], fallback: string | null = ids[0] ?? null) => ({
  revision,
  state: "ready",
  models: ids.map(id => ({ provider: "p", id, name: id.toUpperCase(), thinkingLevels: ["off"] })),
  default: fallback ? { provider: "p", id: fallback, name: fallback.toUpperCase() } : null,
  stale: false,
  error: null,
});

describe("model catalog", () => {
  afterEach(() => modelCatalog.reset());

  it("reads the host's view; anything malformed reads as not listed yet", () => {
    expect(parseCatalog(view(3, ["a", "b"], "b"))).toMatchObject({ revision: 3, state: "ready", default: { id: "b", name: "B" } });
    expect(parseCatalog(view(3, ["a"])).models[0]).toEqual({ provider: "p", id: "a", name: "A", contextWindow: undefined, maxTokens: undefined, cost: undefined, thinkingLevels: ["off"] });
    expect(parseCatalog(null)).toMatchObject({ state: "loading", models: [], default: null });
    expect(parseCatalog({ state: "nonsense", models: [{ id: "no-provider" }] })).toMatchObject({ state: "loading", models: [] });
  });

  it("is read once from the host, then follows models.changed; an older change is ignored", async () => {
    let emit: ((event: ApiEvent) => void) | undefined;
    eventRouter.start({ clientId: "catalog-test", subscribeEvents: (_id: string, _after: number, onEvent: (event: ApiEvent) => void) => { emit = onEvent; return () => {}; } } as unknown as HostClient);
    const read = vi.fn(async () => view(2, ["a"]));
    configureModelCatalog({ read });
    await vi.waitFor(() => expect(modelCatalog.snapshot.revision).toBe(2));
    expect(read).toHaveBeenCalledTimes(1);
    emit?.({ id: 10, event: "models.changed", data: view(4, ["a", "b"], "b") });
    expect(modelCatalog.snapshot).toMatchObject({ revision: 4, default: { id: "b" } });
    expect(modelCatalog.snapshot.models.map(model => model.id)).toEqual(["a", "b"]);
    emit?.({ id: 11, event: "models.changed", data: view(3, ["old"]) });
    expect(modelCatalog.snapshot.revision).toBe(4);
    // Missed events: the catalog is read again, and what the host answers wins.
    read.mockResolvedValueOnce(view(1, ["after-restart"]));
    emit?.({ id: 12, event: "resync", data: {} });
    await vi.waitFor(() => expect(modelCatalog.snapshot.models.map(model => model.id)).toEqual(["after-restart"]));
  });
});
