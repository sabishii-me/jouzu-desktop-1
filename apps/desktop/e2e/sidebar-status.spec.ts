import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// The session list says what each session is doing, background ones included,
// from the host's records (#212). Runs against the built UI (`vite build`) with
// the host's HTTP API stubbed.

const workspace = "C:/Projects/demo";
const now = Date.now();
const row = (name: string, extra: Record<string, unknown>) => ({
  sessionId: null, sessionPath: `C:/s/${name}.jsonl`, workspacePath: workspace, title: `${name} session`,
  status: "idle", updatedAt: new Date(now - 60_000).toISOString(), running: false, pinned: false, archived: false, ...extra,
});
const live = [
  row("Running", { sessionId: "r", status: "running", running: true, activeTurn: { turnId: "t", phase: "running", startedAt: new Date(now - 48_000).toISOString(), step: { n: 2, state: "tools", since: new Date(now - 48_000).toISOString(), tools: [{ id: "1", name: "bash" }] } } }),
  row("Waiting", { sessionId: "w", status: "waiting_approval", running: true, pendingApprovalCount: 1 }),
];
const saved = [
  ...live.map(item => ({ ...item, sessionId: null, status: "stopped", running: false, activeTurn: undefined, pendingApprovalCount: undefined })),
  row("Finished", { status: "stopped", unseenRun: { outcome: "done", endedAt: new Date(now - 30_000).toISOString() } }),
  row("Failed", { status: "stopped", unseenRun: { outcome: "failed", endedAt: new Date(now - 30_000).toISOString() } }),
  row("Quiet", { status: "stopped" }),
  row("Dispatched", { status: "stopped", task: { taskId: "task-1", clientId: "agent-1", clientName: "CI bot" } }),
];

async function setup(page: Page, language: string, seen: string[]) {
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.addInitScript(language => {
    localStorage.setItem("jouzu.ui.language", language);
    (window as any).__JOUZU_HOST__ = { baseUrl: "http://jouzu-ui.test", token: "t" };
  }, language);
  await page.route("http://jouzu-ui.test/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/capabilities") return json({ host: true, native: false, features: [], scopes: ["*"] });
    if (path === "/v1/status") return json({ hostVersion: "x", runtimeHome: "C:/h", node: true, app: true, bash: true, git: true, terminal: false });
    if (path === "/v1/workspaces") return json({ workspaces: [{ id: "w0", path: workspace, environment: { kind: "windows" } }] });
    if (path === "/v1/sessions" && request.method() === "GET") return json({ sessions: live });
    if (path === "/v1/sessions/persisted") return json({ sessions: saved });
    if (path === "/v1/sessions/seen") { seen.push(JSON.parse(request.postData() ?? "{}").sessionPath); return json({}); }
    if (path === "/v1/runtime/warm") return json({ state: "ready", workspace });
    if (path === "/v1/events" || path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": hi\n\n" });
    if (path === "/v1/control") return json({ schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [], models: [] });
    if (path === "/v1/models") return json({ models: [{ provider: "f", id: "d", name: "Fixture model" }] });
    if (path === "/v1/artifacts/counts") return json({ counts: {} });
    if (path === "/v1/sessions/history") return json({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] });
    return json({});
  });
  const dist = resolve("dist");
  await page.route(url => !new URL(url).pathname.startsWith("/v1/"), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(dist, path === "/" ? "index.html" : `.${path}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType: type }); } catch { await route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("http://jouzu-ui.test/");
}

for (const [language, words] of [
  ["en", { running: "Running bash · 0:\\d\\d", waiting: "Waiting for your review", done: "Finished", failed: "Failed", by: "Started by CI bot" }],
  ["ja", { running: "bash を実行中 · 0:\\d\\d", waiting: "確認待ち", done: "完了", failed: "失敗", by: "CI bot が開始" }],
] as const) {
  test(`each session row says what its session is doing (${language})`, async ({ page }) => {
    const seen: string[] = [];
    await setup(page, language, seen);
    const state = (name: string) => page.locator("[data-session-selected], div.group\\/session").filter({ hasText: `${name} session` }).locator("[data-session-state]");
    await expect(state("Running")).toHaveAttribute("data-session-state", "running");
    await expect(state("Running")).toHaveAttribute("title", new RegExp(words.running));
    await expect(state("Waiting")).toHaveAttribute("title", words.waiting);
    await expect(state("Finished")).toHaveAttribute("title", words.done);
    await expect(state("Failed")).toHaveAttribute("title", words.failed);
    await expect(state("Quiet")).toHaveCount(0);
    // A session started as a task says who started it, in place of the plain icon.
    const task = page.locator("div.group\\/session").filter({ hasText: "Dispatched session" }).locator("[data-session-task]");
    await expect(task).toHaveAttribute("title", words.by);
    await page.locator("aside").screenshot({ path: `test-results/sidebar-status-${language}.png` });
    // Opening a session whose run ended unseen tells the host it has been seen.
    await page.locator("button", { hasText: "Finished session" }).click();
    await expect.poll(() => seen).toEqual(["C:/s/Finished.jsonl"]);
  });
}
