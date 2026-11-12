import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

/** Build a self-contained HTML review report from one or more playbook JSON files. */
const files = (process.env.PLAYBOOK_JSON ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (!files.length) throw new Error("set PLAYBOOK_JSON to one or more playbook JSON files");
const out = process.env.PLAYBOOK_OUT ?? "playbook-report.html";
const title = process.env.PLAYBOOK_TITLE ?? "Jouzu playbook report";
const runs = [];
for (const file of files) runs.push(JSON.parse(await readFile(file, "utf8")));

const labels = {
  reloadToReady: ["Reload to ready", 3000],
  newSessionUsable: ["New session usable", 2000],
  modelMenuVisible: ["Model menu visible", 1000],
  ownMessageVisible: ["Own message visible", 100],
  warmFirstReadable: ["Warm first readable", 1000],
  turnObservedEnd: ["Turn observed end", null],
  secondNewSessionUsable: ["Second session usable", 2000],
  savedSessionSwitch: ["Saved-session switch", 2000],
};
const fmt = value => value == null ? "not measured" : `${Math.round(value)} ms`;
const css = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#c9d1d9;--muted:#8b949e;--bad:#f85149;--good:#3fb950;--warn:#d29922;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
main{max-width:1120px;margin:0 auto;padding:32px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}
.sub{color:var(--muted);margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.v{font-size:24px;font-weight:650;margin-top:4px}.bad{color:var(--bad)}.good{color:var(--good)}.warn{color:var(--warn)}
.bar{position:relative;height:26px;background:#0b1220;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:8px}
.fill{height:100%;background:var(--bad)}.fill.ok{background:var(--good)}.mark{position:absolute;top:0;bottom:0;width:2px;background:#fff;opacity:.8}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}code{background:#0b1220;border:1px solid var(--line);padding:1px 5px;border-radius:4px}
.pill{display:inline-block;border-radius:99px;padding:1px 8px;font-size:12px;border:1px solid currentColor}
ul{margin:8px 0 0;padding-left:20px}li{margin:4px 0}.muted{color:var(--muted)}
`;

function latencySection(run) {
  const rows = Object.entries(run.metrics ?? {}).map(([key, value]) => {
    const [label, limit] = labels[key] ?? [key, null];
    const gate = run.gates?.[key];
    const ok = gate ? gate.ok : limit == null ? true : value <= limit;
    const limitValue = gate?.limit ?? limit;
    const ratio = limitValue ? value / limitValue : 0;
    return `<div class="card"><div class="k">${label}</div><div class="v ${ok ? "good" : "bad"}">${fmt(value)}</div>
      <div class="muted">limit: ${limitValue ? fmt(limitValue) : "record only"} ${gate ? (ok ? "· pass" : "· fail") : ""}</div>
      <div class="bar"><div class="fill ${ok ? "ok" : ""}" style="width:${Math.min(100, ratio * 50)}%"></div>
      ${limitValue ? `<div class="mark" style="left:50%"></div>` : ""}</div></div>`;
  }).join("");
  return `<section><h2>Latency profile</h2><div class="grid">${rows}</div></section>`;
}

function scenarioSection(run) {
  const rows = (run.scenarios ?? []).map(item => `<tr><td>${item.name}</td><td class="${item.ok ? "good" : "bad"}">${item.ok ? "pass" : "fail"}</td><td class="muted">${item.detail ?? ""}</td></tr>`).join("");
  const missing = ["Cold process launch", "Working interactivity / stop", "Visible streaming", "Tool / approval / attachment", "5 and 10 session load", "Mixed local + remote", "Remote/browser mode"];
  return `<section><h2>Scenarios</h2><table><thead><tr><th>Scenario</th><th>Result</th><th>Visible detail</th></tr></thead><tbody>${rows || "<tr><td colspan=3>No scenario result recorded</td></tr>"}</tbody></table>
    <h2>Not run in this pass</h2><ul>${missing.map(item => `<li>${item}</li>`).join("")}</ul></section>`;
}

function issueSection() {
  const issues = [
    ["#48", "Warm first readable 4.475 s exceeds 1 s", "2026-11-12T21:50:35+09:00", "product/performance"],
    ["#49", "New sessions missing from sidebar", "2026-11-12T21:54:00+09:00", "product"],
    ["#50", "Own message echo 167 ms once", "2026-11-12T21:53:00+09:00", "unclear"],
  ];
  return `<section><h2>Issues</h2><table><thead><tr><th>ID</th><th>Observation</th><th>Timestamp</th><th>Class</th></tr></thead><tbody>${issues.map(([id, text, time, kind]) => `<tr><td>${id}</td><td>${text}</td><td><code>${time}</code></td><td>${kind}</td></tr>`).join("")}</tbody></table></section>`;
}

const run = runs[0];
const pass = run.pass === true;
const body = `<main>
<h1>${title}</h1>
<div class="sub">Build 1.0.23 · build-test desktop · ${run.startedAt ?? ""} → ${run.finishedAt ?? ""}<br>
Black-box evidence only: accessible actions, visible text, unique reply sentinel. No host logs or source paths.</div>
<div class="card"><div class="k">Verdict</div><div class="v ${pass ? "good" : "bad"}">${pass ? "PASS" : "FAIL"}</div>
<div class="muted">${pass ? "All recorded gates passed." : "At least one gate failed. Not releasable."}</div></div>
${latencySection(run)}
${scenarioSection(run)}
${issueSection()}
<section><h2>Method</h2><p class="muted">The report is generated from playbook JSON. Timing is the user-visible action-to-result interval. The report does not replace the release rule; a green chart from an incomplete run is still not a release sign-off.</p>
<p class="muted">Generated from ${files.map(file => basename(file)).join(", ")}.</p></section>
</main>`;

await writeFile(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`);
console.log(out);
