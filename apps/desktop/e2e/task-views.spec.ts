import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

// Phase 5 of the Assistant plan: every view the Assistant's skill teaches is
// drawn in its pane (board, table, graph, timeline, progress, SVG), with each
// task's live title and state; a block that cannot be read says why; SVG loses
// what the skill forbids. Light and dark, desktop and phone width. Runs
// against the built UI (`vite build`) with the host's HTTP API stubbed.

const workspace = "C:/Projects/demo";
const now = Date.now();
const row = (name: string, extra: Record<string, unknown>) => ({
  sessionId: null, sessionPath: `C:/s/${name}.jsonl`, workspacePath: workspace, title: `${name} session`,
  status: "stopped", updatedAt: new Date(now - 60_000).toISOString(), running: false, pinned: false, archived: false, ...extra,
});
const saved = [
  row("Fix export", { task: { taskId: "task-a", clientId: "assistant" } }),
  row("Release notes", { task: { taskId: "task-b", clientId: "assistant" } }),
  row("Sign build", { task: { taskId: "task-c", clientId: "assistant" } }),
];
const tasks = [
  { taskId: "task-a", sessionPath: "C:/s/Fix export.jsonl", state: "finished" },
  { taskId: "task-b", sessionPath: "C:/s/Release notes.jsonl", state: "running" },
  { taskId: "task-c", sessionPath: "C:/s/Sign build.jsonl", state: "waiting_user" },
  { taskId: "task-d", sessionPath: null, state: "waiting_to_start" },
];
const fence = (language: string, body: unknown) => "```" + language + "\n" + (typeof body === "string" ? body : JSON.stringify(body)) + "\n```";
const reply = [
  "Here is where 1.2 stands.",
  fence("jouzu-view", { view: "board", title: "Release 1.2", columns: [{ title: "Now", taskIds: ["task-b", "task-c"] }, { title: "Next", taskIds: ["task-d"] }, { title: "Done", taskIds: ["task-a"] }] }),
  fence("jouzu-view", { view: "table", title: "Owners", columns: ["Task", "Owner", "Notes"], rows: [{ taskId: "task-a", cells: ["Fix export", "agent", "merged"] }, { taskId: "task-c", cells: ["Sign build", "agent", "needs your key"] }, { cells: ["Changelog", "you", "draft"] }] }),
  fence("jouzu-view", { view: "graph", title: "Order", nodes: [{ id: "design", label: "Design" }, { id: "code", label: "Implement", taskId: "task-a" }, { id: "notes", label: "Release notes", taskId: "task-b" }, { id: "sign", label: "Sign", taskId: "task-c" }], edges: [{ from: "design", to: "code" }, { from: "code", to: "sign" }, { from: "design", to: "notes" }] }),
  fence("jouzu-view", { view: "timeline", title: "Dates", items: [{ at: "2026-11-24", label: "stable", taskId: "task-c" }, { at: "2026-11-21", label: "rc.1 to QA" }] }),
  fence("jouzu-view", { view: "progress", title: "Issues in 1.2", taskIds: ["task-a", "task-b", "task-c", "task-d"] }),
  fence("svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60" width="900" height="300" onload="window.__svgRan=1"><script>window.__svgRan=1</script><rect x="4" y="4" width="192" height="52" rx="8" fill="none" stroke="currentColor"/><text x="100" y="36" text-anchor="middle" fill="currentColor" font-size="16">Ship 1.2</text><a href="https://example.com"><text x="10" y="20">link</text></a><foreignObject><div>x</div></foreignObject><image href="https://example.com/x.png"/></svg>'),
  fence("jouzu-view", '{"view":"board","columns":[{"title":"Now"}]}'),
].join("\n\n");

async function setup(page: Page, language: string, theme: string, opened: string[]) {
  await page.addInitScript(([language, theme]) => {
    localStorage.setItem("jouzu.ui.language", language);
    localStorage.setItem("jouzu.ui.theme", theme);
    (window as any).__JOUZU_HOST__ = { baseUrl: "http://jouzu-ui.test", token: "t" };
  }, [language, theme]);
  await page.route("http://jouzu-ui.test/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/capabilities") return json({ host: true, native: false, features: [], scopes: ["*"] });
    if (path === "/v1/status") return json({ hostVersion: "x", runtimeHome: "C:/h", node: true, app: true, bash: true, git: true, terminal: false });
    if (path === "/v1/workspaces") return json({ workspaces: [{ id: "w0", path: workspace, environment: { kind: "windows" } }] });
    if (path === "/v1/sessions" && request.method() === "GET") return json({ sessions: [] });
    if (path === "/v1/sessions/persisted") return json({ sessions: saved });
    if (path === "/v1/assistant/seen") return json({ enabled: true, model: { provider: "f", id: "d" }, thinkingLevels: [], phase: "idle", error: null, unseen: false });
    if (path === "/v1/assistant") return json({ enabled: true, model: { provider: "f", id: "d" }, thinkingLevels: [], phase: "idle", error: null, unseen: false });
    if (path === "/v1/assistant/messages") return json({ messages: [{ at: "2026-11-21T00:00:00Z", kind: "user", text: "Where does 1.2 stand?" }, { at: "2026-11-21T00:00:01Z", kind: "assistant", text: reply }] });
    if (path === "/v1/assistant/tasks") return json({ tasks });
    if (path === "/v1/projects") return json({ projects: [], sessions: [] });
    if (path === "/v1/sessions/open" || path === "/v1/sessions") { opened.push(request.postData() ?? ""); return json({}); }
    if (path === "/v1/runtime/warm") return json({ state: "ready", workspace });
    if (path === "/v1/events" || path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": hi\n\n" });
    if (path === "/v1/control") return json({ schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [], models: [] });
    if (path === "/v1/models") return json({ models: [{ provider: "f", id: "d", name: "Fixture model" }] });
    if (path === "/v1/artifacts/counts") return json({ counts: {} });
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

const words = {
  en: { assistant: "Assistant (experimental)", hide: "Hide workspaces", progress: "1 of 4 finished", state: "State", waiting: "Waiting for you", invalid: "This view could not be drawn: “columns[0].taskIds” is missing or has the wrong form" },
  ja: { assistant: "アシスタント (試験的)", hide: "ワークスペースを隠す", progress: "4 件中 1 件完了", state: "状態", waiting: "あなたの対応待ち", invalid: "このビューは表示できません: 「columns[0].taskIds」がないか、形が正しくありません" },
} as const;

for (const [language, theme, width] of [["en", "dark", 1280], ["en", "light", 1280], ["ja", "light", 390], ["ja", "dark", 390]] as const) {
  test(`every view the Assistant draws shows live tasks (${language}, ${theme}, ${width}px)`, async ({ page }, info) => {
    const w = words[language];
    await page.setViewportSize({ width, height: 900 });
    const opened: string[] = [];
    await setup(page, language, theme, opened);
    await page.getByRole("button", { name: new RegExp(w.assistant.replace(/[()]/g, "\\$&")) }).first().click();
    // At phone width the folder list covers the pane until it is put away.
    if (width < 768) await page.getByRole("complementary").getByRole("button", { name: w.hide }).click();
    const pane = page.locator(`section[aria-label="${w.assistant}"]`);
    const message = pane.locator('article[aria-label="assistant message"]');
    for (const kind of ["board", "table", "graph", "timeline", "progress", "svg"]) await expect(message.locator(`[data-jouzu-view="${kind}"]`)).toHaveCount(1);
    // Nothing is left as raw JSON: the one bad block says what is wrong.
    await expect(message.locator('[data-jouzu-view="invalid"]')).toHaveCount(1);
    await expect(message.locator('[data-jouzu-view="invalid"] figcaption')).toHaveText(w.invalid);
    // Titles and states come from the tasks, live.
    const board = message.locator('[data-jouzu-view="board"]');
    await expect(board.getByRole("button", { name: /Release notes session/ })).toHaveAttribute("data-task-state", "running");
    await expect(board.locator('[data-task-state="waiting_to_start"]')).toContainText("task-d");
    await expect(message.locator('[data-jouzu-view="table"] th').last()).toHaveText(w.state);
    await expect(message.locator('[data-jouzu-view="table"]').getByRole("button", { name: new RegExp(w.waiting) })).toBeVisible();
    await expect(message.locator('[data-jouzu-view="graph"] [data-graph-node]')).toHaveCount(4);
    await expect(message.locator('[data-jouzu-view="timeline"] time').first()).toHaveText("2026-11-21");
    await expect(message.locator('[data-jouzu-view="progress"] [data-progress-done]')).toHaveText(w.progress);
    // The SVG is drawn without what the skill forbids, and nothing in it ran.
    const svg = message.locator("[data-svg-view] svg");
    await expect(svg).toBeVisible();
    expect(await svg.evaluate(node => ({
      script: node.querySelectorAll("script, foreignObject, image, a").length,
      handlers: [...node.querySelectorAll("*"), node].some(element => [...element.attributes].some(attribute => attribute.name.startsWith("on"))),
      width: node.getAttribute("width"), height: node.getAttribute("height"),
      ran: (window as any).__svgRan ?? 0,
    }))).toEqual({ script: 0, handlers: false, width: "200", height: null, ran: 0 });
    // No sideways scroll of the page at phone width: wide views scroll inside their frame.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`task-views-${language}-${theme}-${width}.png`), fullPage: false });
    // The whole reply, on a page tall enough to hold it.
    await page.setViewportSize({ width, height: 2600 });
    await message.screenshot({ path: info.outputPath(`message-${language}-${theme}-${width}.png`) });
    await page.setViewportSize({ width, height: 900 });
    for (const kind of ["board", "graph", "progress"]) await message.locator(`[data-jouzu-view="${kind}"]`).screenshot({ path: info.outputPath(`view-${kind}-${language}-${theme}-${width}.png`) });
    // A task opens its session.
    await board.getByRole("button", { name: /Fix export session/ }).click();
    await expect(pane).toBeHidden();
  });
}
