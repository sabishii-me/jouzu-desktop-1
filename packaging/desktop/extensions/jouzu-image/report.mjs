// The image report: which providers the user added, which of them can make
// images now, their models and sizes, and the defaults. The extension is its
// only writer; the host reads it and relays it to Settings → Tools.
//
// agent/jouzu-image/report.json
//   { schema, generation, computedAt, usable, defaults: { provider, model, size, maxImages },
//     providers: [{ id, label, usable, code?, reason?, detail?, refusedWith?, models: [{ id, sizes }] }] }
//
// `generation` is the host's word for the configuration the report was computed
// under, passed with the refresh command; a write-back after a refused
// generation keeps it. Providers nobody added are not listed.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codeOf } from "./providers/errors.mjs";

export const SCHEMA = 1;
export const DEFAULT_SIZE = "1K";
export const DEFAULT_MAX_IMAGES = 3;
/** Refusals that hold until the sign-in, the credit or the plan changes. */
export const LASTING = ["sign-in-refused", "no-credit", "not-allowed"];

export function reportPath(agentDir) {
  return join(agentDir, "jouzu-image", "report.json");
}

/** A short, one-way mark of the credential a refusal was given for. */
export function fingerprint(credential) {
  const secret = credential?.token ?? JSON.stringify(Object.keys(credential ?? {}));
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
}

export async function readReport(agentDir) {
  try {
    const value = JSON.parse(await readFile(reportPath(agentDir), "utf8"));
    return value?.schema === SCHEMA && Array.isArray(value.providers) ? value : null;
  } catch {
    return null;
  }
}

/** Written through a temporary file and a rename, so a reader never sees half a report. */
export async function writeReport(agentDir, report) {
  const path = reportPath(agentDir);
  await mkdir(join(agentDir, "jouzu-image"), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
  return report;
}

function finish(providers, generation) {
  const first = providers.find(provider => provider.usable);
  return {
    schema: SCHEMA,
    generation: generation ?? null,
    computedAt: new Date().toISOString(),
    usable: Boolean(first),
    defaults: { provider: first?.id ?? "", model: first?.models[0]?.id ?? "", size: DEFAULT_SIZE, maxImages: DEFAULT_MAX_IMAGES },
    providers,
  };
}

function unusable(provider, error, extra = {}) {
  return {
    id: provider.id,
    label: provider.label,
    usable: false,
    code: codeOf(error),
    reason: String(error?.message ?? error),
    ...(error?.detail ? { detail: String(error.detail) } : {}),
    models: [],
    ...extra,
  };
}

/**
 * Check every provider. A provider without a credential is left out. A lasting
 * refusal written back for the same credential stays until `recheck`, so the
 * extension does not keep asking a service that already said no.
 */
export async function computeReport(registry, providers, { generation, previous, recheck = false } = {}) {
  const entries = await Promise.all(providers.map(async provider => {
    let credential;
    try {
      credential = await provider.credential(registry);
    } catch {
      // A credential the runtime refuses to hand out (a local sign-out) is no credential.
      credential = undefined;
    }
    if (!credential) return null;
    const mark = fingerprint(credential);
    const earlier = previous?.providers?.find(entry => entry.id === provider.id);
    if (!recheck && earlier?.refusedWith === mark && !earlier.usable) return { ...earlier, label: provider.label };
    try {
      const models = await provider.listModels(credential);
      if (!models.length) return unusable(provider, Object.assign(new Error(`${provider.label} lists no image models.`), { code: "not-allowed" }));
      return { id: provider.id, label: provider.label, usable: true, models };
    } catch (error) {
      return unusable(provider, error);
    }
  }));
  return finish(entries.filter(Boolean), generation);
}

/** A generation was refused for a lasting reason: the provider is not offered again with this credential. */
export async function writeBack(agentDir, providerId, error, credential) {
  if (!LASTING.includes(codeOf(error))) return null;
  const current = await readReport(agentDir);
  if (!current) return null;
  const providers = current.providers.map(entry => entry.id === providerId
    ? unusable(entry, error, { refusedWith: fingerprint(credential) })
    : entry);
  return writeReport(agentDir, finish(providers, current.generation));
}
