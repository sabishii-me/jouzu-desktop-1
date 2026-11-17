/**
 * The model the person last picked, remembered by this window for its next new
 * session. It is the window's own memory: the host keeps no such choice, and the
 * runtime is not asked. A remembered model the catalog no longer lists is not
 * picked; the new session then has no model until the person picks one.
 */
import type { ChatModel } from "./chat-types";

const KEY = "jouzu.lastModel.v1";

export type ModelChoice = { provider: string; id: string };

export function rememberModel(choice: ModelChoice): void {
  try { localStorage.setItem(KEY, JSON.stringify({ provider: choice.provider, id: choice.id })); } catch { /* storage unavailable: nothing is remembered */ }
}

function recalled(): ModelChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const { provider, id } = value as Record<string, unknown>;
    return typeof provider === "string" && provider && typeof id === "string" && id ? { provider, id } : null;
  } catch { return null; }
}

/** The remembered model as the catalog lists it now, or nothing. */
export function lastModel(models: readonly ChatModel[]): ChatModel | null {
  const choice = recalled();
  return choice ? models.find(model => model.provider === choice.provider && model.id === choice.id) ?? null : null;
}
