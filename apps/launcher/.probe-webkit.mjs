import { webkit } from "playwright";

const PORT = process.env.HOST_PORT;
const TOKEN = process.env.HOST_TOKEN;
const base = `http://127.0.0.1:${PORT}`;

const browser = await webkit.launch();
const page = await browser.newPage();
const t0 = Date.now();

page.on("console", m => {
  const txt = m.text();
  if (txt.startsWith("[probe]") || (m.type() === "error" && !txt.includes("two children"))) {
    console.log(`CONSOLE[${((Date.now() - t0) / 1000).toFixed(1)}s]`, txt.slice(0, 300));
  }
});
page.on("pageerror", e => console.log(`PAGEERROR[${((Date.now() - t0) / 1000).toFixed(1)}s]`, String(e).slice(0, 400)));

await page.addInitScript(([b, tok]) => {
  window.__JOUZU_HOST__ = { baseUrl: b, token: tok };
  const orig = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? (typeof input !== "string" && input.method) ?? "GET";
    const id = Math.random().toString(36).slice(2, 8);
    const started = performance.now();
    console.log(`[probe] ${id} ${method} ${url.replace(b, "")} →`);
    try {
      const res = await orig(input, init);
      console.log(`[probe] ${id} ${method} ${new URL(url).pathname} ← ${res.status} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
      return res;
    } catch (err) {
      console.log(`[probe] ${id} ${method} ${new URL(url).pathname} THREW ${String(err)} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
      throw err;
    }
  };
}, [base, TOKEN]);

await page.goto("http://localhost:1420", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2500);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 150));
  console.log(`T+${(i + 1) * 2.5}s:`, JSON.stringify(body.replace(/\n+/g, " | ")));
}
await browser.close();
