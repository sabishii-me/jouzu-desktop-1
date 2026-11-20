import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// The Assistant's pane shows what waits for the person and their projects; its
// sidebar entry carries a dot until the person looks (D3 of the 1.1.5 plan).
// Runs against the built UI (`vite build`) with the host's HTTP API stubbed.

const workspace = "C:/Projects/demo";
const now = Date.now();
const row = (name: string, extra: Record<string, unknown>) => ({
  sessionId: null, sessionPath: `C:/s/${name}.jsonl`, workspacePath: workspace, title: `${name} session`,
  status: "idle", updatedAt: new Date(now - 60_000).toISOString(), running: false, pinned: false, archived: false, ...extra,
});
const live = [
  row("Approve", { sessionId: "w", status: "waiting_approval", running: true, pendingApprovalCount: 1, task: { taskId: "task-1", clientId: "assistant" } }),
];
const saved = [
  ...live.map(item => ({ ...item, sessionId: null, status: "stopped", running: false, pendingApprovalCount: undefined })),
  row("Plan", { status: "stopped" }),
  row("Mine", { status: "stopped" }),
];
const projects = [{ id: "p1", name: "Release 1.1.5", description: "Ship the Assistant\nmore notes", workspaceIds: [], sessionIds: ["plan"], taskIds: ["task-1"] }];

async function setup(page: Page, language: string, seen: string[], assistant: { unseen: boolean }) {
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
    if (path === "/v1/assistant/seen") { seen.push("assistant"); assistant.unseen = false; return json({ enabled: true, model: { provider: "f", id: "d" }, thinkingLevels: [], phase: "idle", error: null, unseen: false }); }
    if (path === "/v1/assistant") return json({ enabled: true, model: { provider: "f", id: "d" }, thinkingLevels: [], phase: "idle", error: null, unseen: assistant.unseen });
    if (path === "/v1/assistant/messages") return json({ messages: [{ at: "2026-11-21T00:00:00Z", kind: "user", text: "Fix the build" }, { at: "2026-11-21T00:00:01Z", kind: "assistant", text: "Started a task for it." }] });
    if (path === "/v1/projects") return json({ projects, sessions: [{ sessionId: "plan", sessionPath: "C:/s/Plan.jsonl", title: "Plan session" }] });
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
  ["en", { assistant: "Assistant (experimental)", waiting: "Waiting for you", projects: "Projects", by: "Waiting for your review · Started by the Assistant" }],
  ["ja", { assistant: "アシスタント (試験的)", waiting: "あなたの対応待ち", projects: "プロジェクト", by: "確認待ち · アシスタントが開始" }],
] as const) {
  test(`the Assistant pane shows what waits for you and your projects (${language})`, async ({ page }) => {
    const seen: string[] = [];
    await setup(page, language, seen, { unseen: true });
    const entry = page.getByRole("button", { name: new RegExp(words.assistant.replace(/[()]/g, "\\$&")) });
    await expect(entry.locator("[data-assistant-attention]")).toHaveCount(1);
    await entry.click();
    const pane = page.locator(`section[aria-label="${words.assistant}"]`);
    const waiting = pane.locator(`section[aria-label="${words.waiting}"]`);
    await expect(waiting.getByRole("button", { name: /Approve session/ })).toBeVisible();
    await expect(waiting.locator("[data-session-state]")).toHaveAttribute("title", words.by);
    await expect(pane.getByText("Ship the Assistant")).toBeVisible();
    await pane.getByRole("button", { name: /Release 1\.1\.5/ }).click();
    const projectList = pane.locator(`section[aria-label="${words.projects}"]`);
    await expect(projectList.getByRole("button", { name: /Plan session/ })).toBeVisible();
    await expect(projectList.getByRole("button", { name: /Approve session/ })).toBeVisible();
    // Looking at the pane marks what it said as seen; the dot stays while a task waits.
    await expect.poll(() => seen).toContain("assistant");
    await expect(entry.locator("[data-assistant-attention]")).toHaveCount(1);
    await page.screenshot({ path: `test-results/assistant-overview-${language}.png` });
    // Opening a waiting task goes to its session.
    await waiting.getByRole("button", { name: /Approve session/ }).click();
    await expect(pane).toBeHidden();
  });
}
