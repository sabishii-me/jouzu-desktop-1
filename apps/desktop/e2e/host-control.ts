import type { Page } from "@playwright/test";

/** The UI base URL. Playwright must point at this repository''s dev server. */
export const UI_BASE = process.env.JOUZU_UI_BASE ?? "http://localhost:1420";

export type Workspace = { id: string; path: string; environment: { kind: string } };

/** What a control handler can do besides answering: show a sign-in's device code, push host events and hear a cancel. */
export type HostStub = {
  device(data: Record<string, unknown>): void;
  emit(event: string, data: Record<string, unknown>): void;
  onCancel(cancel: () => void): () => void;
  /** Set the runtime installation the host reports (`AppView.installation`) and publish it. */
  installation(value: Record<string, unknown> | null): void;
};

/**
 * These specs run the UI against the dev server with no host behind it, so the
 * host's /v1 API is answered at the network boundary. Without this the dev
 * server answers every /v1 path with index.html and the UI reads HTML as data.
 * `control` plays the configuration service: it gets `{ action, ...fields }` for
 * each queued operation and answers the settings (or throws to fail it). The
 * stub plays the host's queue around it: `POST /v1/config/{kind}` is accepted at
 * once, operations run one at a time, and `app.updated` carries the snapshot.
 * A `modelReady` field in the answer is the fixture's runtime: it answers one
 * model unless it is `false`; it is not sent to the window. Like the host, every
 * operation that changes configuration raises `configGeneration` and publishes
 * the models as `updating` and the tools as `checking`, then publishes the
 * runtime's answers for the new generation: the model list, and the image
 * report `tools` gives for it. `PATCH /v1/tools` saves the fields sent and
 * `POST /v1/tools/refresh` asks for the report again.
 * The rest is an idle host: the given folders, no sessions, nothing running.
 * A path not listed here is a 404, as from a host that does not serve it.
 */
export async function stubHost(
  page: Page,
  options: {
    control: (body: any, host: HostStub) => unknown;
    workspaces?: Workspace[];
    /** The image report for a generation; `null` keeps the tools `checking`. */
    tools?: { image?: Record<string, unknown>; report: (generation: number) => unknown };
    /** The runtime installation the host starts with. Absent: a host given its runtime. */
    installation?: Record<string, unknown>;
    /** `POST /v1/runtime/{action}`: the stub's installation answers through `host.installation`. */
    runtime?: (action: string, host: HostStub) => void;
  },
) {
  const workspaces = [...(options.workspaces ?? [])];
  // Events wait here until the window's stream next connects. The stub answers
  // each stream with what is queued and ends it; the window reconnects, as it
  // does when a real host closes the stream.
  const queued: string[] = [];
  let seq = 0;
  const cancels = new Set<() => void>();
  const send = (event: string, data: Record<string, unknown>) => { seq += 1; queued.push(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify({ ...data, seq })}\n\n`); };
  let modelReady = true;
  const fixtureModel = { provider: "fixture", id: "model", name: "Fixture model" };
  const image = { enabled: true, provider: "", model: "", size: "1K", maxImages: 3, ...(options.tools?.image ?? {}) };
  const view: { revision: number; config: { running: any; queued: any[]; lastResult: Record<string, unknown> }; settings: any; configGeneration: number; models: any; tools: any; installation?: Record<string, unknown> | null } = {
    revision: 0,
    config: { running: null, queued: [], lastResult: {} },
    settings: null,
    configGeneration: 0,
    models: { generation: null, state: "updating", list: [], startModel: null },
    tools: { settings: { image, reviewTools: ["generate_image"] }, report: null, state: "checking" },
    installation: options.installation ?? null,
  };
  const publish = () => { view.revision += 1; send("app.updated", JSON.parse(JSON.stringify(view))); };
  /** The runtimes of the current generation answer. */
  const answer = () => {
    view.models = { generation: view.configGeneration, state: "ready", list: modelReady ? [fixtureModel] : [], startModel: modelReady ? fixtureModel : null };
    const report = options.tools ? options.tools.report(view.configGeneration) : { usable: false, defaults: { provider: "", model: "", size: "1K", maxImages: 3 }, providers: [] };
    view.tools = { ...view.tools, report: report ?? view.tools.report, state: report ? "ready" : "checking" };
    publish();
  };
  const host: HostStub = {
    // A device code belongs to the running sign-in, as the host reports it.
    device(data) { if (view.config.running) { view.config.running.device = data; publish(); } },
    emit(event, data) { send(event, data); },
    onCancel(cancel) { cancels.add(cancel); return () => cancels.delete(cancel); },
    installation(value) { view.installation = value; publish(); },
  };
  let chain: Promise<unknown> = Promise.resolve();
  let next = 0;
  const enqueue = (kind: string, body: Record<string, unknown>) => {
    const operationId = `op-${++next}`;
    const position = view.config.queued.length + (view.config.running ? 1 : 0);
    view.config.queued.push({ operationId, kind, position });
    publish();
    chain = chain.then(async () => {
      view.config.queued = view.config.queued.filter(item => item.operationId !== operationId);
      view.config.running = { operationId, kind, startedAt: new Date().toISOString() };
      publish();
      let result: Record<string, unknown>;
      try {
        const answer: any = await options.control({ action: kind, ...body }, host);
        const { modelReady: ready, catalog, ...settings } = answer ?? {};
        if (typeof ready === "boolean") modelReady = ready;
        view.settings = settings;
        // A catalog outcome belongs to the operation that reported it.
        result = { operationId, ok: true, code: null, params: catalog ? { catalog } : {}, text: null };
      } catch (error) {
        const text = String((error as Error)?.message ?? error);
        result = { operationId, ok: false, code: text === "cancelled" ? "config-cancelled" : "config-failed", params: {}, text };
      }
      // A configuration change: a new generation, nothing answered for it yet.
      const changed = kind !== "status" && result.ok;
      if (changed) {
        view.configGeneration += 1;
        view.models = { ...view.models, generation: null, state: "updating", list: [] };
        view.tools = { ...view.tools, state: "checking" };
      }
      view.config.running = null;
      // The provider the operation was for, as the host records it with the result.
      const provider = typeof body.provider === "string" ? body.provider : null;
      view.config.lastResult[kind] = { ...result, provider, finishedAt: new Date().toISOString() };
      publish();
      if (changed || view.models.state !== "ready") setTimeout(answer, 50);
    });
    return { operationId, position };
  };
  // The host reads the settings once when it starts.
  enqueue("status", {});
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/v1/app") { await chain; return route.fulfill(json(view)); }
    const config = /^\/v1\/config\/([a-z-]+)$/.exec(path);
    if (config && method === "POST") return route.fulfill(json(enqueue(config[1], request.postDataJSON() ?? {}), 202));
    if (/^\/v1\/config\/operations\/[^/]+\/cancel$/.test(path)) { for (const cancel of [...cancels]) cancel(); return route.fulfill({ status: 204, body: "" }); }
    if (path === "/v1/timing") return route.fulfill({ status: 204, body: "" });
    if (path === "/v1/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: queued.splice(0).join("") });
    }
    if (path === "/v1/capabilities") return route.fulfill(json({ features: ["chat", "sse", "replay", "prompts", "history-paging"], scopes: ["loopback"] }));
    if (path === "/v1/workspaces" && method === "GET") return route.fulfill(json({ workspaces }));
    if (path === "/v1/workspaces" && method === "POST") {
      for (const folder of (request.postDataJSON()?.paths ?? []) as string[]) {
        if (!workspaces.some(item => item.path === folder)) workspaces.push({ id: `windows:${folder}`, path: folder, environment: { kind: "windows" } });
      }
      return route.fulfill(json({ workspaces }));
    }
    if (path === "/v1/environment") return route.fulfill(json({ entries: [] }));
    if (path === "/v1/sessions" || path === "/v1/sessions/persisted") return route.fulfill(json({ sessions: [] }));
    if (path === "/v1/models") { await chain; return route.fulfill(json({ models: modelReady ? [fixtureModel] : [] })); }
    if (path === "/v1/tools" && method === "GET") return route.fulfill(json(view.tools));
    if (path === "/v1/tools" && method === "PATCH") {
      view.tools.settings.image = { ...view.tools.settings.image, ...(request.postDataJSON()?.image ?? {}) };
      publish();
      return route.fulfill(json(view.tools));
    }
    if (path === "/v1/tools/refresh" && method === "POST") { answer(); return route.fulfill(json(view.tools)); }
    if (path === "/v1/runtime/warm") return route.fulfill(json({ state: "off" }));
    const runtime = /^\/v1\/runtime\/(install|update|repair)$/.exec(path);
    if (runtime && method === "POST") {
      const started = view.installation?.state !== "installing";
      if (started) options.runtime?.(runtime[1], host);
      return route.fulfill(json({ started, installation: view.installation }, 202));
    }
    if (path === "/v1/artifacts/counts") return route.fulfill(json({ counts: {} }));
    return route.fulfill(json({ error: { code: "not-found", message: `No stub for ${method} ${path}` } }, 404));
  });
}

/** Only the control endpoints, for a spec whose other host calls do not matter. */
export async function stubHostControl(page: Page, handler: (body: any, host: HostStub) => unknown, workspaces?: Workspace[]) {
  await stubHost(page, { control: handler, workspaces });
}

/** The empty status every spec starts from, matching the control-state parser. */
export const emptyControlState = {
  schemaVersion: 1,
  profile: "core",
  account: { signedIn: false },
  credentials: [],
  customProviders: [],
  providers: [],
};
