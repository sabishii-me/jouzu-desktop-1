/**
 * The host's model catalog, as this page shows it.
 *
 * The host relays the runtime's one list of models and its saved default, as
 * the runtime gives them. The page reads it once and then follows
 * `models.changed`; it never lists models per session and keeps no copy of its
 * own. The last picked model is this window's memory (last-model.ts).
 */
import { useSyncExternalStore } from "react";
import type { ChatModel } from "./chat-types";
import { eventRouter } from "./event-router";

export interface ModelCatalog {
  revision: number;
  /** `loading` until the host has listed the models once; `failed` if that first listing failed. */
  state: "loading" | "ready" | "failed";
  models: ChatModel[];
  default: { provider: string; id: string; name: string } | null;
  /** A later listing failed: these are the models listed before. */
  stale: boolean;
  error: string | null;
}

export const emptyCatalog: ModelCatalog = { revision: 0, state: "loading", models: [], default: null, stale: false, error: null };

const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function modelOf(value: unknown): ChatModel | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const provider = text(row.provider);
  const id = text(row.id);
  if (!provider || !id) return null;
  const cost = row.cost && typeof row.cost === "object" ? row.cost as ChatModel["cost"] : undefined;
  return {
    provider,
    id,
    name: text(row.name) ?? id,
    contextWindow: count(row.contextWindow),
    maxTokens: count(row.maxTokens),
    cost,
    thinkingLevels: Array.isArray(row.thinkingLevels) ? row.thinkingLevels.filter((level): level is string => typeof level === "string") : [],
  };
}

/** Read the host's catalog view; anything malformed reads as not listed yet. */
export function parseCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object") return emptyCatalog;
  const data = value as Record<string, unknown>;
  const state = data.state === "ready" || data.state === "failed" ? data.state : "loading";
  const models = Array.isArray(data.models) ? data.models.map(modelOf).filter((model): model is ChatModel => !!model) : [];
  const fallback = data.default && typeof data.default === "object" ? data.default as Record<string, unknown> : null;
  const provider = text(fallback?.provider);
  const id = text(fallback?.id);
  return {
    revision: typeof data.revision === "number" ? data.revision : 0,
    state,
    models,
    default: provider && id ? { provider, id, name: text(fallback?.name) ?? id } : null,
    stale: data.stale === true,
    error: text(data.error) ?? null,
  };
}

type Source = { read(): Promise<unknown>; refresh?(): Promise<unknown> };

class CatalogStore {
  private current: ModelCatalog = emptyCatalog;
  private readonly listeners = new Set<() => void>();
  private source?: Source;
  private unsubscribe?: () => void;

  start(source: Source): void {
    this.source = source;
    this.unsubscribe?.();
    this.unsubscribe = eventRouter.subscribe(event => {
      if (event.event === "models.changed") this.take(parseCatalog(event.data));
      // Events were missed: read the catalog again.
      else if (event.event === "resync") void this.read();
    });
    void this.read();
  }

  get snapshot(): ModelCatalog {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private async read(): Promise<void> {
    if (!this.source) return;
    try { this.take(parseCatalog(await this.source.read())); }
    catch { /* The stream's next `models.changed` carries it; the composer shows the catalog as loading meanwhile. */ }
  }

  /** Ask the host to list the models again (after a failed listing). The answer, or the host's refusal, arrives as `models.changed`. */
  async refresh(): Promise<void> {
    try { if (this.source?.refresh) this.take(parseCatalog(await this.source.refresh())); }
    catch { /* The failure is in the catalog the host publishes. */ }
  }

  /** A view older than the one shown (a read racing an event) is ignored. A restarted host reloads the page, so revisions only grow. */
  private take(next: ModelCatalog): void {
    if (next.revision < this.current.revision) return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  /** Tests start from a known catalog. */
  reset(next: ModelCatalog = emptyCatalog): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.source = undefined;
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}

export const modelCatalog = new CatalogStore();

export function configureModelCatalog(source: Source): void {
  modelCatalog.start(source);
}

export function useModelCatalog(): ModelCatalog {
  return useSyncExternalStore(modelCatalog.subscribe, () => modelCatalog.snapshot);
}
