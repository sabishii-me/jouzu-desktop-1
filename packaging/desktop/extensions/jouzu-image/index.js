// Jouzu Desktop's image generation tool. Installed into the agent's extension
// folder by the desktop; it is not part of the runtime and uses only pi's public
// extension API.
//
// Owners:
// - Credentials are the runtime's: each provider asks `getProviderAuth(id)`,
//   the path chat uses. This tool never reads, refreshes or stores one.
// - Which providers can make images is this extension's answer, written as the
//   report (report.mjs) when the host sends `/jouzu-image-refresh`.
// - The user's choices are `agent/tools.json`, written by the host.
//
// A provider is one file in providers/ with `credential(registry)`,
// `listModels(credential)` -> [{ id, sizes }] and `generate(credential, { model,
// size, prompt, signal })` -> { data, mime }. Every failure carries one of the
// codes in providers/errors.mjs.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { saveArtifact } from "./artifacts.mjs";
import { chosen } from "./choice.mjs";
import codex from "./providers/codex.mjs";
import { coded } from "./providers/errors.mjs";
import { runtimeProviders } from "./providers/runtime.mjs";
import shisa from "./providers/shisa.mjs";
import { DEFAULT_MAX_IMAGES, DEFAULT_SIZE, computeReport, readReport, writeBack, writeReport } from "./report.mjs";

export const TOOL = "generate_image";
export const REFRESH = "jouzu-image-refresh";
const OWN = [shisa, codex];
const SIZES = ["1K", "2K", "4K"];

/** The agent folder the runtime set for this process. */
export function agentDir() {
  const value = process.env.PI_CODING_AGENT_DIR;
  if (!value) throw new Error("The runtime did not set PI_CODING_AGENT_DIR.");
  return value;
}

/** Every image provider the extension knows: its own adapters, then the runtime's. */
export function providers(registry) {
  return [...OWN, ...runtimeProviders(registry, OWN.map(provider => provider.id))];
}

function count(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 10 ? number : fallback;
}

/** The user's choices. An empty provider or model means "not chosen". */
export async function settings(dir = agentDir()) {
  let value = {};
  try {
    value = JSON.parse(await readFile(join(dir, "tools.json"), "utf8")) ?? {};
  } catch {
    value = {};
  }
  const image = value.image ?? {};
  return {
    image: {
      enabled: image.enabled !== false,
      provider: typeof image.provider === "string" ? image.provider.trim() : "",
      model: typeof image.model === "string" ? image.model.trim() : "",
      size: SIZES.includes(image.size) ? image.size : DEFAULT_SIZE,
      maxImages: count(image.maxImages, DEFAULT_MAX_IMAGES),
    },
    reviewTools: Array.isArray(value.reviewTools) ? value.reviewTools.filter(item => typeof item === "string") : [TOOL],
  };
}

/**
 * What a call will actually use, or why it cannot run: the switch, the
 * provider in the report, the model, the size and the count are all checked
 * here, before anyone is asked to approve.
 */
export function resolve(current, report, input = {}) {
  const image = current.image;
  if (!image.enabled) throw coded("other", "Image generation is off in Settings → Tools.");
  if (!report) throw coded("other", "Image providers are still being checked.");
  // What applies when the call names nothing: the same rule the Tools card shows.
  const fallback = chosen(image, report);
  const entry = input.provider ? report.providers.find(provider => provider.id === input.provider) : fallback.provider;
  if (!entry) throw coded("other", input.provider ? `${input.provider} is not added as an image provider.` : "No image provider can make images.");
  if (!entry.usable) throw coded(entry.code ?? "other", `${entry.label}: ${entry.reason ?? "cannot make images now."}`);
  const modelId = input.model || (entry === fallback.provider ? fallback.model?.id : entry.models[0]?.id);
  const model = entry.models.find(candidate => candidate.id === modelId);
  if (!model) throw coded("other", `${entry.label} does not offer the image model ${modelId}.`);
  let size = null;
  if (model.sizes.length) {
    size = input.size || (model === fallback.model ? fallback.size : model.sizes.includes(image.size) ? image.size : model.sizes[0]);
    if (!model.sizes.includes(size)) throw coded("other", `${model.id} does not make ${size} images. It makes ${model.sizes.join(", ")}.`);
  }
  const images = input.count === undefined ? 1 : Number(input.count);
  if (!Number.isInteger(images) || images < 1 || images > image.maxImages) {
    throw coded("other", `Ask for 1 to ${image.maxImages} image${image.maxImages === 1 ? "" : "s"} per call (Settings → Tools).`);
  }
  return { provider: entry.id, label: entry.label, model: model.id, size, count: images };
}

/** Recompute the report and write it. `generation` comes from the host. */
export async function refresh(registry, { generation = null, recheck = false, dir = agentDir() } = {}) {
  const previous = await readReport(dir);
  const report = await computeReport(registry, providers(registry), { generation, previous, recheck });
  return writeReport(dir, report);
}

async function saveImages(dir, { images, prompt, provider, model, sessionId, toolCallId }) {
  const home = dirname(dir);
  const saved = [];
  for (const result of images) {
    const bytes = Buffer.from(result.data, "base64");
    const artifact = await saveArtifact({
      home,
      kind: "images",
      mimeType: result.mime,
      bytes,
      prompt,
      source: { tool: TOOL, provider, model, sessionId, toolCallId },
    });
    saved.push({
      id: artifact.id,
      data: result.data,
      mimeType: artifact.mimeType,
      path: join(home, "artifacts", artifact.path),
      bytes: artifact.bytes,
      width: artifact.dimensions?.width ?? null,
      height: artifact.dimensions?.height ?? null,
    });
  }
  return saved;
}

/** Run a call the tool_call hook resolved. Only run-time failures remain here. */
export async function generate(registry, { provider: providerId, model, size, count: total, prompt, sessionId, toolCallId, signal }, dir = agentDir()) {
  const provider = providers(registry).find(candidate => candidate.id === providerId);
  if (!provider) throw coded("other", `${providerId} is not an image provider.`);
  const credential = await provider.credential(registry).catch(() => undefined);
  if (!credential) throw coded("sign-in-refused", `${provider.label} is no longer signed in.`);
  const images = [];
  try {
    for (let index = 0; index < total; index += 1) {
      images.push(await provider.generate(credential, { model, size, prompt, signal }));
    }
  } catch (error) {
    // A refusal that will repeat is written back, so the tool goes away until it can work.
    await writeBack(dir, provider.id, error, credential).catch(() => null);
    throw error;
  }
  const saved = await saveImages(dir, { images, prompt, provider: provider.id, model, sessionId, toolCallId });
  return { provider: provider.id, label: provider.label, model, size, images: saved };
}

export function reviewText(resolved, prompt) {
  // The desktop renders these fields; a client without the review card still sees readable JSON.
  return JSON.stringify({
    tool: TOOL,
    images: resolved.count,
    prompt,
    provider: resolved.provider,
    model: resolved.model,
    // Models without a size choice name none; naming one would mislead.
    ...(resolved.size ? { size: resolved.size } : {}),
  });
}

function message(error) {
  return error?.detail ? `${error.message}\n${error.detail}` : String(error?.message ?? error);
}

function parseRefresh(args) {
  const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  return { generation: words.find(word => !word.startsWith("--")) ?? null, recheck: words.includes("--recheck") };
}

export default function jouzuImage(pi) {
  const approved = new Set();
  let sessionId = "";

  pi.on("session_start", (_event, ctx) => {
    approved.clear();
    try { sessionId = ctx?.sessionManager?.getSessionId?.() ?? ""; } catch { sessionId = ""; }
  });

  // The host asks for a new report after every configuration change and on Check again.
  pi.registerCommand(REFRESH, {
    description: "Check which image providers can make images (used by Jouzu Desktop).",
    handler: async (args, ctx) => {
      await refresh(ctx.modelRegistry, parseRefresh(args));
    },
  });

  // The tool is in a turn only when the switch is on and the chosen provider can
  // make images. The cached report decides; no request is made per turn.
  pi.on("before_agent_start", async () => {
    let active = false;
    try {
      resolve(await settings(), await readReport(agentDir()));
      active = true;
    } catch {
      active = false;
    }
    const tools = pi.getActiveTools();
    const has = tools.includes(TOOL);
    if (active && !has) pi.setActiveTools([...tools, TOOL]);
    if (!active && has) pi.setActiveTools(tools.filter(name => name !== TOOL));
  });

  // Check, then ask, then run.
  pi.on("tool_call", async (event, ctx) => {
    const current = await settings();
    let text;
    if (event.toolName === TOOL) {
      let resolved;
      try {
        resolved = resolve(current, await readReport(agentDir()), event.input ?? {});
      } catch (error) {
        return { block: true, reason: message(error) };
      }
      // The call runs with exactly what was checked and shown.
      Object.assign(event.input, { provider: resolved.provider, model: resolved.model, count: resolved.count });
      if (resolved.size) event.input.size = resolved.size;
      else delete event.input.size;
      text = reviewText(resolved, String(event.input.prompt ?? ""));
    }
    if (!current.reviewTools.includes(event.toolName) || approved.has(event.toolName)) return undefined;
    text ??= JSON.stringify({ tool: event.toolName, input: event.input });
    const choice = await ctx.ui.select(`Review tool call\n${text}`, ["Approve", "Approve for this session", "Deny"], { timeout: 120_000 });
    if (choice === "Approve") return undefined;
    if (choice === "Approve for this session") { approved.add(event.toolName); return undefined; }
    return { block: true, reason: choice === "Deny" ? "The user declined this tool call." : "No response; the tool call was declined." };
  });

  pi.registerTool({
    name: TOOL,
    label: "Generate Image",
    defaultActive: false,
    description:
      "Generate one to a few images from a text prompt with the image provider chosen in Settings → Tools. " +
      "The provider, model and size come from Settings → Tools unless passed here.",
    promptSnippet: "Generate images from a prompt with the configured image provider",
    promptGuidelines: [
      "Use generate_image when the user asks for an image.",
      "The user may review a generate_image call before it runs; do not ask for approval in the message.",
      "generate_image stores each image as an artifact and returns its path.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw." },
        count: { type: "integer", minimum: 1, description: "How many images; defaults to 1, capped by Settings → Tools." },
        provider: { type: "string", description: "Optional image provider id; defaults to Settings → Tools." },
        model: { type: "string", description: "Optional model; defaults to Settings → Tools or the provider's first model." },
        size: { type: "string", enum: SIZES, description: "Optional size, for models that take one." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = String(params.prompt ?? "").trim();
      let result;
      try {
        result = await generate(ctx.modelRegistry, {
          provider: params.provider,
          model: params.model,
          size: params.size ?? null,
          count: params.count ?? 1,
          prompt,
          sessionId,
          toolCallId,
          signal,
        });
      } catch (error) {
        throw new Error(message(error));
      }
      const lines = result.images.map((image, index) => `${index + 1}. ${image.path}`).join("\n");
      return {
        content: [
          { type: "text", text: `Generated ${result.images.length} image${result.images.length === 1 ? "" : "s"}.\nPrompt: "${prompt}"\nProvider: ${result.label} · Model: ${result.model}${result.size ? ` · Size: ${result.size}` : ""}\n${lines}` },
          ...result.images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType })),
        ],
        details: {
          prompt,
          provider: result.provider,
          model: result.model,
          size: result.size,
          images: result.images.map(({ data: _data, ...image }) => image),
          usage: null,
        },
      };
    },
  });
}
