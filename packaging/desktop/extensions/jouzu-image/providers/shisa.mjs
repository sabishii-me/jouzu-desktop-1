// Shisa.AI image provider. One implementation of the image provider interface
// (described in index.js): credential, listModels, generate.
//
// The credential is the runtime's: `getProviderAuth("shisa")`, the same path
// chat uses, so a sign-out or an expired sign-in behaves here as it does there.
//
// The image model list depends on the account's plan. A free account gets
// `200 {"object":"list","data":[]}` from `GET /image/models`, and generation
// answers `403 model_not_in_plan` (checked 2026-11-26 with a free account).
// So an empty list means "this plan does not include image generation"
// (`not-allowed`), not "no models".
import { coded } from "./errors.mjs";

const BASE = "https://api.shisa.ai/image";

// Size capability lives with the provider: the models endpoint does not publish it.
const SIZES = { "gemini-3.1-flash-lite-image": ["1K"], "gemini-3.1-flash-image": ["1K", "2K", "4K"], "gemini-3-pro-image": ["1K", "2K", "4K"] };
const ALL_SIZES = ["1K", "2K", "4K"];

async function failure(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? body?.code;
  const raw = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
  // The router names its errors; the name decides over the status.
  if (code === "model_not_in_plan") return coded("not-allowed", "This account's plan does not include image generation.", raw);
  if (code === "insufficient_balance" || code === "free_allowance_exhausted") return coded("no-credit", "This account is out of credit for image generation.", raw);
  if (response.status === 401) return coded("sign-in-refused", "Sign in to Shisa.AI again to generate images.", raw);
  if (response.status === 402) return coded("no-credit", "This account is out of credit for image generation.", raw);
  if (response.status === 403) return coded("not-allowed", "This account cannot use image generation.", raw);
  if (response.status === 400) return coded("other", "The model or image size was rejected.", raw);
  if (response.status === 413) return coded("other", "The prompt is too large.", raw);
  if (response.status === 429 || response.status === 503) return coded("busy", "Image generation is busy. Try again in a moment.", raw);
  return coded("other", `Image generation failed (HTTP ${response.status}).`, raw);
}

export default {
  id: "shisa",
  label: "Shisa.AI",

  /** The runtime's credential for Shisa.AI, or undefined when none is added. */
  async credential(registry) {
    const resolved = await registry.getProviderAuth("shisa");
    const key = resolved?.auth?.apiKey;
    return typeof key === "string" && key.trim() ? { token: key.trim() } : undefined;
  },

  /** The sizes this model accepts; unknown models keep the full set. */
  sizes(model) {
    return SIZES[model] ?? ALL_SIZES;
  },

  /** The account's image models. An empty list is this plan's answer: `not-allowed`. */
  async listModels(credential) {
    const response = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(error => {
      throw coded("unreachable", "Shisa.AI could not be reached.", String(error?.message ?? error));
    });
    if (!response.ok) throw await failure(response);
    const body = await response.json().catch(() => null);
    const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
    const models = list
      .map(item => item?.name ?? item?.id)
      .filter(value => typeof value === "string")
      .map(value => value.replace(/^models\//, "").trim())
      .filter(Boolean);
    if (!models.length) throw coded("not-allowed", "This account's plan does not include image generation.", "The image model list is empty.");
    return models.map(id => ({ id, sizes: this.sizes(id) }));
  },

  async generate(credential, { model, size, prompt, signal }) {
    const response = await fetch(`${BASE}/v1beta/interactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: prompt, store: false, response_format: { type: "image", image_size: size } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    }).catch(error => {
      if (signal?.aborted) throw error;
      throw coded("unreachable", "Shisa.AI could not be reached.", String(error?.message ?? error));
    });
    if (!response.ok) throw await failure(response);
    const body = await response.json().catch(() => null);
    const image = (body?.steps ?? [])
      .flatMap(step => (Array.isArray(step?.content) ? step.content : []))
      .find(item => item?.type === "image");
    if (!image?.data) throw coded("other", "The answer contained no image.");
    return { data: image.data, mime: image.mime_type ?? "image/png" };
  },
};
