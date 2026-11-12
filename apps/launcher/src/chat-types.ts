import type { ChatProjection } from "./chat-projection";

/** One id per page load: handles from an older page are released by the host. */
export const pageGeneration = globalThis.crypto.randomUUID();

export interface ChatImage { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }
export interface ChatModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevels?: string[];
}
export interface SessionStats {
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  contextUsage?: { percent?: number | null; tokens?: number; contextWindow?: number };
}
export interface SessionTiming { modelMs: number; toolMs: number; turns: number; steps: number; outputTokens: number }
const MODEL_PREFERENCE_KEY = "jouzu.chat.model";

/** Flow notices belong in the Flow panel; strip their terminal-command instruction. */
export function flowNoticeText(message: string): string | undefined {
  if (!/\/flow\b/iu.test(message)) return undefined;
  const text = message
    .replace(/\s*Run \/flow[^.]*\.?/giu, "")
    .replace(/\s*Inspect with \/flow[^.]*\.?/giu, "")
    .trim();
  return text || "Flow needs attention.";
}
export function readModelPreference(): { provider: string; id: string } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_PREFERENCE_KEY) ?? "null");
    return value && typeof value.provider === "string" && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
}
export function writeModelPreference(value: { provider: string; id: string } | undefined) {
  try {
    if (value) localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MODEL_PREFERENCE_KEY);
  } catch { /* A webview without storage keeps the selection for this session only. */ }
}

export interface ChatSnapshot {
  projection: ChatProjection;
  connected: boolean;
  transportReady?: boolean;
  pending: boolean;
  error: string | null;
  /** The runtime is reachable but its transcript could not be read. */
  historyError?: string;
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  modelProvider?: string;
  modelId?: string;
  models?: ChatModel[];
  modelsLoaded?: boolean;
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
  flowNotice?: string;
  stats?: SessionStats;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  /** The transcript was compacted after a display backlog and will be reloaded. */
  gap?: boolean;
}
