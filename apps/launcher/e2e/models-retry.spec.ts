import { test, expect } from "@playwright/test";

// A first-install account can be signed in before the catalog key is readable.
// The chat runtime then starts with zero models. This reproduces that state
// without touching a real account: the control status says signed in, the first
// catalog refresh fails, and only a later refresh returns the model catalog.
test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

test("recovers models after a failed first catalog refresh", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const records: any[] = [];
    const models = [{ provider: "shisa", id: "fixture-model", name: "Fixture model" }];
    let catalogReady = false;
    let catalogRefreshes = 0;
    w.catalogRefreshes = () => catalogRefreshes;
    const status = () => ({
      schemaVersion: 1,
      modelReady: true,
      profile: "core",
      account: { signedIn: true, dashboardUrl: "https://platform.shisa.ai/en/dashboard" },
      credentials: [{ providerId: "shisa" }],
      customProviders: [],
      providers: [],
      models: catalogReady ? models : [],
    });
    const response = (r: any, data?: any) => records.push({ type: "response", id: r.id, command: r.type, success: true, data });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "launcher_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: "C:/Projects/Example", environment: { kind: "windows" } }] };
        if (command === "control_request") {
          const action = args.request.action;
          if (action === "status") return status();
          if (action === "refresh-catalogs") {
            catalogRefreshes++;
            // The first refreshes race account activation; the explicit retry succeeds.
            if (catalogRefreshes < 4) throw new Error("Models could not be refreshed. Sign in to Shisa.AI again or add a provider key.");
            catalogReady = true;
            return status();
          }
          return status();
        }
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return [];
        if (command === "chat_flow_reports") return [];
        if (command === "chat_session_timing") return { modelMs: 0, toolMs: 0, turns: 0, steps: 0, outputTokens: 0 };
        if (command === "environment_read") return [];
        if (command === "console_repair_needed") return false;
        if (command === "chat_start") return "models-test";
        if (command === "chat_poll") return { records: records.splice(0), closed: false };
        if (command === "chat_send") {
          const r = args.request;
          if (r.type === "get_state") response(r, { sessionId: "models-test", sessionFile: "C:/sessions/models-test.jsonl", isStreaming: false, model: catalogReady ? { name: "Fixture model", provider: "shisa", id: "fixture-model" } : undefined });
          else if (r.type === "get_messages") response(r, { messages: [] });
          else if (r.type === "get_available_models") response(r, { models: catalogReady ? models : [] });
          else if (r.type === "get_available_thinking_levels") response(r, { levels: [] });
          else if (r.type === "get_session_stats") response(r, { userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, contextUsage: { percent: 0, tokens: 0, contextWindow: 100000 } });
          else if (r.type === "set_model") response(r, models[0]);
          else response(r);
          return;
        }
        if (command.includes("version")) return "0.3.8";
        return 1;
      },
    };
  });
  const dist = "dist";
  await page.route("http://jouzu-ui.test/**", async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const { readFile } = await import("node:fs/promises");
    const { resolve, extname, sep } = await import("node:path");
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(resolve(dist) + sep)) return route.abort();
    const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();

  // The catalog starts empty; automatic retries fail while the key is not
  // readable. The model menu must still offer a way out, and that retry restarts
  // the session with the returned model.
  await expect.poll(async () => await page.evaluate(() => (window as any).catalogRefreshes()), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Refresh models" })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText("Key saved");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Model" }).click();
  const menu = page.getByRole("menu", { name: "Model selection" });
  await expect(menu).toContainText("No models available", { timeout: 15_000 });
  await menu.getByRole("button", { name: "Retry models" }).click();
  await expect.poll(async () => await page.evaluate(() => (window as any).catalogRefreshes()), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await expect(page.getByRole("button", { name: "Model" })).toContainText("Fixture model", { timeout: 15_000 });
});
