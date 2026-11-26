// @ts-nocheck
// The jouzu-image extension against a fake runtime registry and mocked
// endpoints, in an isolated agent folder. Nothing here depends on what any
// machine has configured.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { REFRESH, TOOL, refresh, resolve, settings } from "../../../packaging/desktop/extensions/jouzu-image/index.js";
import { readReport } from "../../../packaging/desktop/extensions/jouzu-image/report.mjs";
import codex from "../../../packaging/desktop/extensions/jouzu-image/providers/codex.mjs";

function png(width, height, payload = "x") {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([header, size, Buffer.from(payload)]);
}
const bytes = png(1024, 1024);
const b64 = bytes.toString("base64");

// A ChatGPT access token carries the account id in its payload.
const codexToken = ["h", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url"), "s"].join(".");

const flux = { type: "image", id: "flux-test", provider: "openrouter" };

/** The runtime's registry, reduced to the public calls the extension makes. */
function registry({ shisa = false, codex: chatgpt = false, openrouter = false, generateImages } = {}) {
  const auth = { shisa: shisa && "shisa-token", "openai-codex": chatgpt && codexToken, openrouter: openrouter && "or-key" };
  return {
    getProviderAuth: async id => (auth[id] ? { auth: { apiKey: auth[id], headers: {} }, source: "stored" } : undefined),
    getProviderAuthStatus: id => ({ configured: Boolean(auth[id]) }),
    // The registry lists image models for providers nobody added.
    getModelsOfType: (_type, provider) => [flux].filter(model => !provider || model.provider === provider),
    getProviderDisplayName: id => (id === "openrouter" ? "OpenRouter" : id),
    generateImages: generateImages ?? vi.fn(async () => ({ stopReason: "stop", output: [{ type: "image", data: b64, mimeType: "image/png" }] })),
  };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

/** Shisa endpoints: the account's model list and generation. */
function shisaEndpoints({ models = [{ name: "models/gemini-3.1-flash-image" }], list = 200, generate = 200, error } = {}) {
  return vi.fn(async (url, init) => {
    if (String(url).endsWith("/image/models")) return json(list, list === 200 ? { object: "list", data: models } : { error });
    if (String(url).includes("chatgpt.com")) return json(200, { data: [{ b64_json: b64 }] });
    return json(generate, generate === 200 ? { steps: [{ content: [{ type: "image", mime_type: "image/png", data: b64 }] }] } : { error });
  });
}

function load() {
  const tools = [];
  const handlers = new Map();
  const commands = new Map();
  let active = ["read", "bash"];
  const pi = {
    registerTool: tool => tools.push(tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => [...active],
    setActiveTools: names => { active = [...names]; },
  };
  extension(pi);
  return {
    tool: tools[0],
    commands,
    active: () => active,
    run: async (event, payload, ctx) => {
      let result;
      for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
      return result;
    },
  };
}

let dir = null;
function agent(tools) {
  const home = mkdtempSync(join(tmpdir(), "jouzu-image-"));
  dir = join(home, "agent");
  mkdirSync(dir, { recursive: true });
  if (tools) writeFileSync(join(dir, "tools.json"), JSON.stringify(tools));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

beforeEach(() => {
  vi.stubGlobal("fetch", shisaEndpoints());
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
  dir = null;
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("the report", () => {
  it("lists only added providers: Shisa only, ChatGPT only, neither, both", async () => {
    const cases = [
      [{ shisa: true }, ["shisa"]],
      [{ codex: true }, ["openai-codex"]],
      [{}, []],
      [{ shisa: true, codex: true }, ["shisa", "openai-codex"]],
    ];
    for (const [added, ids] of cases) {
      agent();
      const report = await refresh(registry(added), { generation: "g-1" });
      expect(report.providers.map(provider => provider.id)).toEqual(ids);
      expect(report.usable).toBe(ids.length > 0);
      expect(report.generation).toBe("g-1");
      expect(report.defaults.provider).toBe(ids[0] ?? "");
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("leaves out a runtime provider the registry lists but nobody added", async () => {
    agent();
    expect((await refresh(registry())).providers).toEqual([]);
    const report = await refresh(registry({ openrouter: true }));
    expect(report.providers).toEqual([{ id: "openrouter", label: "OpenRouter", usable: true, models: [{ id: "flux-test", sizes: [] }] }]);
  });

  it("marks a Shisa plan without images as not allowed when the model list is empty", async () => {
    agent();
    vi.stubGlobal("fetch", shisaEndpoints({ models: [] }));
    const report = await refresh(registry({ shisa: true }));
    expect(report.usable).toBe(false);
    expect(report.providers[0]).toMatchObject({ id: "shisa", usable: false, code: "not-allowed" });
  });

  it("marks an account out of credit at report time", async () => {
    agent();
    vi.stubGlobal("fetch", shisaEndpoints({ list: 402, error: { code: "insufficient_balance" } }));
    expect((await refresh(registry({ shisa: true }))).providers[0]).toMatchObject({ usable: false, code: "no-credit" });
  });

  it("keeps a provider that cannot be reached as added but unusable", async () => {
    agent();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await refresh(registry({ shisa: true }))).providers[0]).toMatchObject({ usable: false, code: "unreachable" });
  });

  it("is written whole, through a rename, where the host reads it", async () => {
    agent();
    await refresh(registry({ shisa: true }), { generation: "g-2" });
    expect(readdirSync(join(dir, "jouzu-image"))).toEqual(["report.json"]);
    expect(JSON.parse(readFileSync(join(dir, "jouzu-image", "report.json"), "utf8")).generation).toBe("g-2");
  });

  it("is refreshed by the command the host sends, which starts no turn", async () => {
    agent();
    const { commands } = load();
    await commands.get(REFRESH).handler("g-7", { modelRegistry: registry({ codex: true }) });
    const report = await readReport(dir);
    expect(report.generation).toBe("g-7");
    expect(report.providers[0]).toMatchObject({ id: "openai-codex", usable: true, models: [{ id: "gpt-image-2", sizes: ["1K"] }] });
  });
});

describe("when the tool is in a turn", () => {
  it("is registered inactive, then added only when the chosen provider can make images", async () => {
    agent();
    const { tool, active, run } = load();
    expect(tool.defaultActive).toBe(false);
    await run("before_agent_start", {});
    expect(active()).not.toContain(TOOL);
    await refresh(registry({ shisa: true }));
    await run("before_agent_start", {});
    expect(active()).toContain(TOOL);
  });

  it("goes away on the next turn when the switch is turned off", async () => {
    agent({ image: { enabled: true } });
    const { active, run } = load();
    await refresh(registry({ shisa: true }));
    await run("before_agent_start", {});
    expect(active()).toContain(TOOL);
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ image: { enabled: false } }));
    await run("before_agent_start", {});
    expect(active()).not.toContain(TOOL);
  });

  it("is absent when the only added provider cannot make images", async () => {
    agent();
    vi.stubGlobal("fetch", shisaEndpoints({ models: [] }));
    const { active, run } = load();
    await refresh(registry({ shisa: true }));
    await run("before_agent_start", {});
    expect(active()).not.toContain(TOOL);
  });
});

describe("check, then ask, then run", () => {
  async function ready(tools = { image: { provider: "shisa" }, reviewTools: [TOOL] }) {
    agent(tools);
    await refresh(registry({ shisa: true }));
    return load();
  }

  it("blocks a model the provider does not offer without asking", async () => {
    const { run } = await ready();
    const select = vi.fn();
    const result = await run("tool_call", { toolName: TOOL, input: { prompt: "a cat", model: "nope" } }, { ui: { select } });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("nope");
    expect(select).not.toHaveBeenCalled();
  });

  it("blocks a size the model does not make, and a count over the limit, without asking", async () => {
    vi.stubGlobal("fetch", shisaEndpoints({ models: [{ name: "gemini-3.1-flash-lite-image" }] }));
    const { run } = await ready({ image: { provider: "shisa", maxImages: 2 }, reviewTools: [TOOL] });
    const select = vi.fn();
    expect((await run("tool_call", { toolName: TOOL, input: { prompt: "x", size: "4K" } }, { ui: { select } })).block).toBe(true);
    expect((await run("tool_call", { toolName: TOOL, input: { prompt: "x", count: 3 } }, { ui: { select } })).block).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it("asks with the values that will be used, and runs with exactly those", async () => {
    const { run } = await ready();
    const select = vi.fn(async () => "Approve");
    const input = { prompt: "a cat", count: 2 };
    expect(await run("tool_call", { toolName: TOOL, input }, { ui: { select } })).toBeUndefined();
    const body = JSON.parse(select.mock.calls[0][0].split("\n")[1]);
    expect(body).toEqual({ tool: TOOL, images: 2, prompt: "a cat", provider: "shisa", model: "gemini-3.1-flash-image", size: "1K" });
    expect(input).toMatchObject({ provider: "shisa", model: "gemini-3.1-flash-image", size: "1K", count: 2 });
  });

  it("names no size for a model without a size choice", async () => {
    agent({ image: { provider: "openrouter" }, reviewTools: [TOOL] });
    await refresh(registry({ openrouter: true }));
    const { run } = load();
    const select = vi.fn(async () => "Approve");
    const input = { prompt: "x", size: "2K" };
    await run("tool_call", { toolName: TOOL, input }, { ui: { select } });
    expect(JSON.parse(select.mock.calls[0][0].split("\n")[1]).size).toBeUndefined();
    expect(input.size).toBeUndefined();
  });

  it("remembers 'approve for this session' until the session restarts", async () => {
    const { run } = await ready();
    const select = vi.fn(async () => "Approve for this session");
    await run("tool_call", { toolName: TOOL, input: { prompt: "x" } }, { ui: { select } });
    await run("tool_call", { toolName: TOOL, input: { prompt: "y" } }, { ui: { select } });
    expect(select).toHaveBeenCalledTimes(1);
    await run("session_start", {}, {});
    await run("tool_call", { toolName: TOOL, input: { prompt: "z" } }, { ui: { select } });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("blocks a denied call", async () => {
    const { run } = await ready();
    const result = await run("tool_call", { toolName: TOOL, input: { prompt: "x" } }, { ui: { select: async () => "Deny" } });
    expect(result).toMatchObject({ block: true, reason: "The user declined this tool call." });
  });

  it("saves each image as an artifact and returns it", async () => {
    const { tool, run } = await ready({ image: { provider: "shisa" }, reviewTools: [] });
    const input = { prompt: "a cat", count: 2 };
    await run("tool_call", { toolName: TOOL, input }, { ui: {} });
    const result = await tool.execute("call-1", input, undefined, undefined, { modelRegistry: registry({ shisa: true }) });
    expect(result.details.images).toHaveLength(2);
    expect(result.details.images[0]).toMatchObject({ width: 1024, height: 1024, mimeType: "image/png" });
    const sidecars = readdirSync(join(dir, "..", "artifacts", "images")).filter(name => name.endsWith(".json"));
    expect(sidecars).toHaveLength(1);
  });

  it("writes a plan refusal back, so the tool goes away until the sign-in changes or Check again", async () => {
    const { tool, run, active } = await ready({ image: { provider: "shisa" }, reviewTools: [] });
    vi.stubGlobal("fetch", shisaEndpoints({ generate: 403, error: { code: "model_not_in_plan", message: "Model not in plan" } }));
    const input = { prompt: "x" };
    await run("tool_call", { toolName: TOOL, input }, { ui: {} });
    await expect(tool.execute("call-1", input, undefined, undefined, { modelRegistry: registry({ shisa: true }) })).rejects.toThrow("plan does not include");
    const report = await readReport(dir);
    expect(report.providers[0]).toMatchObject({ usable: false, code: "not-allowed" });
    expect(report.providers[0].refusedWith).toMatch(/^[0-9a-f]{16}$/);
    await run("before_agent_start", {});
    expect(active()).not.toContain(TOOL);
    // A refresh for another reason keeps the refusal for the same credential.
    vi.stubGlobal("fetch", shisaEndpoints());
    expect((await refresh(registry({ shisa: true }))).providers[0].usable).toBe(false);
    // Check again asks the service again.
    expect((await refresh(registry({ shisa: true }), { recheck: true })).providers[0].usable).toBe(true);
  });

  it("does not write back a passing failure", async () => {
    const { tool, run } = await ready({ image: { provider: "shisa" }, reviewTools: [] });
    vi.stubGlobal("fetch", shisaEndpoints({ generate: 503 }));
    const input = { prompt: "x" };
    await run("tool_call", { toolName: TOOL, input }, { ui: {} });
    await expect(tool.execute("call-1", input, undefined, undefined, { modelRegistry: registry({ shisa: true }) })).rejects.toThrow("busy");
    expect((await readReport(dir)).providers[0].usable).toBe(true);
  });
});

describe("ChatGPT images", () => {
  const credential = { token: codexToken, headers: {}, account: "acct-test" };
  const answer = (status, body) => vi.stubGlobal("fetch", vi.fn(async () => json(status, body)));

  it("returns the image, sending the account id", async () => {
    answer(200, { data: [{ b64_json: b64 }] });
    expect(await codex.generate(credential, { model: "gpt-image-2", size: "1K", prompt: "x" })).toEqual({ data: b64, mime: "image/png" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(init.headers["chatgpt-account-id"]).toBe("acct-test");
    expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-image-2", size: "1024x1024" });
  });

  it("maps 401 to a refused sign-in", async () => {
    answer(401, { error: { message: "expired" } });
    await expect(codex.generate(credential, { prompt: "x" })).rejects.toMatchObject({ code: "sign-in-refused" });
  });

  it("maps a usage limit to no credit, and a plan without images to not allowed", async () => {
    answer(429, { error: { code: "usage_limit_reached" } });
    await expect(codex.generate(credential, { prompt: "x" })).rejects.toMatchObject({ code: "no-credit" });
    answer(403, { error: { code: "usage_not_included" } });
    await expect(codex.generate(credential, { prompt: "x" })).rejects.toMatchObject({ code: "not-allowed" });
  });

  it("maps an answer it does not recognise to unreachable, keeping the raw text", async () => {
    answer(200, { something: "else" });
    await expect(codex.generate(credential, { prompt: "x" })).rejects.toMatchObject({ code: "unreachable", detail: expect.stringContaining("something") });
    answer(502, { oops: true });
    await expect(codex.generate(credential, { prompt: "x" })).rejects.toMatchObject({ code: "unreachable" });
  });

  it("is not added without a ChatGPT sign-in", async () => {
    expect(await codex.credential(registry())).toBeUndefined();
  });
});

describe("settings", () => {
  it("reads an empty provider and model as not chosen", async () => {
    agent({ image: { enabled: false, provider: "", model: "" } });
    expect((await settings()).image).toEqual({ enabled: false, provider: "", model: "", size: "1K", maxImages: 3 });
  });

  it("uses the report's default provider when none is chosen", async () => {
    agent();
    const report = await refresh(registry({ codex: true }));
    expect(resolve(await settings(), report)).toMatchObject({ provider: "openai-codex", model: "gpt-image-2", size: "1K", count: 1 });
  });
});
