// ChatGPT (Codex) image provider.
//
// The credential is pi's own ChatGPT sign-in (`getProviderAuth("openai-codex")`,
// added under Model providers). Codex CLI is not needed and `~/.codex` is not read.
//
// The endpoint is not documented. Everything about it stays in this file: the
// request and response handling follows @crazygit/pi-codex-image-gen 0.2.2
// (MIT, src/client/codex-images.ts and src/auth/codex-auth.ts). An answer this
// file does not recognise is `unreachable`, with the raw text kept for Details.
//
// There is no model list: the service names one model. Whether the plan
// includes images shows only when generating, so a refusal there is written
// back to the report (index.js) instead of being guessed here.
import { coded } from "./errors.mjs";

const GENERATIONS = "https://chatgpt.com/backend-api/codex/images/generations";
const MODEL = "gpt-image-2";
// The service takes pixel sizes; 1K is the only tier it offers.
const SIZES = { "1K": "1024x1024" };
const MAX_BODY = 36 * 1024 * 1024;
const LIMIT = /usage[_ ]limit[_ ]reached|usage[_ ]not[_ ]included|insufficient[_ ]quota|monthly[_ ]limit|billing[_ ]hard[_ ]limit/i;
const NOT_INCLUDED = /usage[_ ]not[_ ]included/i;
const MODERATION = /moderation|content_policy|safety/i;

/** The ChatGPT account id carried in the access token. */
export function accountId(token) {
  try {
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

function errorPayload(text) {
  try {
    const body = JSON.parse(text);
    const error = body?.error && typeof body.error === "object" ? body.error : body;
    return { code: error?.code, type: error?.type, message: error?.message };
  } catch {
    return {};
  }
}

async function readBody(response) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw coded("unreachable", "The ChatGPT image service answered with too much data.");
  return response.text();
}

export default {
  id: "openai-codex",
  label: "ChatGPT",

  async credential(registry) {
    const resolved = await registry.getProviderAuth("openai-codex");
    const token = resolved?.auth?.apiKey;
    if (typeof token !== "string" || !token.trim()) return undefined;
    return { token: token.trim(), headers: resolved.auth.headers ?? {}, account: accountId(token.trim()) };
  },

  sizes() {
    return Object.keys(SIZES);
  },

  /** One model, offered when the sign-in carries a ChatGPT account. */
  async listModels(credential) {
    if (!credential.account) throw coded("sign-in-refused", "Sign in to ChatGPT again to generate images.", "The sign-in carries no ChatGPT account.");
    return [{ id: MODEL, sizes: this.sizes() }];
  },

  async generate(credential, { model, size, prompt, signal }) {
    if (!credential.account) throw coded("sign-in-refused", "Sign in to ChatGPT again to generate images.");
    let response;
    try {
      response = await fetch(GENERATIONS, {
        method: "POST",
        redirect: "error",
        headers: {
          ...credential.headers,
          authorization: `Bearer ${credential.token}`,
          "chatgpt-account-id": credential.account,
          originator: "pi",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model: model || MODEL, prompt, background: "auto", quality: "auto", size: SIZES[size] ?? SIZES["1K"] }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw coded("unreachable", "The ChatGPT image service could not be reached.", String(error?.message ?? error));
    }
    const text = await readBody(response);
    if (response.ok) {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw coded("unreachable", "The ChatGPT image service gave an answer that could not be read.", text.slice(0, 500));
      }
      const data = Array.isArray(body?.data) ? body.data[0]?.b64_json : undefined;
      if (typeof data !== "string" || !data) throw coded("unreachable", "The ChatGPT image service returned no image.", text.slice(0, 500));
      return { data, mime: "image/png" };
    }
    const error = errorPayload(text);
    const signalText = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`;
    const detail = error.message || text.slice(0, 500) || `HTTP ${response.status}`;
    if (NOT_INCLUDED.test(signalText)) throw coded("not-allowed", "This ChatGPT plan does not include image generation.", detail);
    if (LIMIT.test(signalText)) throw coded("no-credit", "This ChatGPT account has reached its image limit.", detail);
    if (MODERATION.test(signalText)) throw coded("other", "The image request was blocked by the provider's safety checks.", detail);
    if (response.status === 401) throw coded("sign-in-refused", "Sign in to ChatGPT again to generate images.", detail);
    if (response.status === 403) throw coded("not-allowed", "This ChatGPT account cannot use image generation.", detail);
    if (response.status === 429) throw coded("busy", "Image generation is busy. Try again in a moment.", detail);
    if (response.status === 400) throw coded("other", "The ChatGPT image service rejected the request.", detail);
    throw coded("unreachable", `The ChatGPT image service did not answer as expected (HTTP ${response.status}).`, detail);
  },
};
