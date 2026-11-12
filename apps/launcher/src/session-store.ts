/**
 * Host-backed session state for the UI.
 *
 * One Store owns one HostChatSession: attach, history, SSE, send and teardown.
 * The views consume the ChatSnapshot shape and call these methods; there is no
 * second transport or runtime command layer behind it.
 */
import { HostChatSession } from "./api/chat-session";
import type { ApiEvent, Attachment, HistoryPage, JouzuApi, Receipt } from "./api/jouzu-api";
import { emptyProjection, historyRowsProjection, type ToolView, type WireObject } from "./chat-projection";
import {
  readModelPreference,
  writeModelPreference,
  type ChatImage,
  type ChatModel,
  type ChatSnapshot,
  type SessionStats,
} from "./chat-types";

export interface SessionPort {
  readonly id: string;
  history(page?: { limit?: number; before?: number }): Promise<HistoryPage>;
  send(message: { clientMessageId: string; text: string; attachments?: Attachment[] }): Promise<Receipt>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  detach(): void;
  follow(onEvent: (event: ApiEvent) => void, onError: (error: unknown) => void): void;
}

export type SessionDialog = (request: WireObject, client: SessionStore) => void;

const emptySnapshot = (): ChatSnapshot => ({
  projection: emptyProjection(),
  connected: false,
  pending: false,
  error: null,
  models: [],
  thinkingLevels: [],
});

const modelOf = (model: Awaited<ReturnType<JouzuApi["models"]["list"]>>[number]): ChatModel => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  cost: model.cost,
  thinkingLevels: model.thinkingLevels,
});

export class SessionStore {
  private state: ChatSnapshot = emptySnapshot();
  private readonly listeners = new Set<(state: ChatSnapshot) => void>();
  private active = -1;
  private disposed = false;
  private preferred = readModelPreference();
  private api?: JouzuApi;
  private dialog?: SessionDialog;

  private constructor(
    readonly session: SessionPort,
    private readonly onDispose?: () => void,
  ) {
    this.state = { ...this.state, sessionId: session.id, connected: true };
  }

  static async open(
    api: JouzuApi,
    workspacePath: string,
    sessionPath?: string,
    dialog?: SessionDialog,
  ): Promise<SessionStore> {
    const session = await HostChatSession.open(api, workspacePath, sessionPath);
    const store = SessionStore.attach(session, undefined, api);
    store.dialog = dialog;
    await store.load();
    return store;
  }

  static attach(session: SessionPort, onDispose?: () => void, api?: JouzuApi): SessionStore {
    const store = new SessionStore(session, onDispose);
    store.api = api;
    session.follow(event => store.handle(event), error => store.fail(error));
    return store;
  }

  private async load(): Promise<void> {
    await this.refreshHistory();
    await this.loadModels();
    await this.loadThinkingLevels();
    await this.applyPreferredModel();
    void this.loadStats();
  }

  get snapshot(): ChatSnapshot {
    return this.state;
  }

  subscribe(listener: (state: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  isDisposed(): boolean { return this.disposed; }

  clearError(): void { this.update({ error: null }); }

  retryHistory(): Promise<void> { return this.refreshHistory(); }

  async send(text: string, attachments: Attachment[] = [], clientMessageId: string = crypto.randomUUID()): Promise<Receipt> {
    this.update({ pending: true, error: null });
    try {
      return await this.session.send({ clientMessageId, text, attachments });
    } catch (error) {
      this.update({ pending: false, error: String(error) });
      throw error;
    }
  }

  async loadHistory(): Promise<void> { await this.refreshHistory(); }

  async refreshHistory(): Promise<void> {
    try {
      const page = await this.session.history({ limit: 200 });
      this.active = -1;
      this.update({ projection: historyRowsProjection(page.messages), historyError: undefined });
    } catch (error) {
      this.update({ historyError: String(error) });
    }
  }

  async sendOrSteer(text: string, images: readonly ChatImage[] = [], _running = false): Promise<void> {
    if (this.state.pending) throw new Error("Wait for the current request to be accepted.");
    this.update({ pending: true, error: null });
    try {
      await this.session.send({
        clientMessageId: crypto.randomUUID(),
        text,
        attachments: images.map((image, index) => ({
          name: `image-${index + 1}`,
          mimeType: image.mimeType,
          data: image.data,
        })),
      });
    } catch (error) {
      this.update({ pending: false, error: String(error) });
      throw error;
    }
  }

  async loadModels(): Promise<void> {
    try {
      if (!this.api) throw new Error("The host API is unavailable.");
      const models = (await this.api.models.list(this.session.id)).map(modelOf);
      this.update({ models, modelsLoaded: true });
    } catch (error) {
      this.update({ error: `Could not read the model list. ${String(error)}`, modelsLoaded: true });
    }
  }

  async selectModel(provider: string, id: string): Promise<void> {
    try {
      if (!this.api) throw new Error("The host API is unavailable.");
      await this.api.models.select(this.session.id, provider, id);
      const name = this.state.models?.find(model => model.provider === provider && model.id === id)?.name ?? id;
      this.preferred = { provider, id };
      writeModelPreference(this.preferred);
      this.update({ model: name, modelProvider: provider, modelId: id, error: null });
    } catch (error) {
      this.update({ error: String(error) });
      throw error;
    }
  }

  async loadThinkingLevels(): Promise<void> {
    const levels = new Set<string>();
    for (const model of this.state.models ?? []) for (const level of model.thinkingLevels ?? []) levels.add(level);
    this.update({ thinkingLevels: [...levels] });
  }

  async setThinkingLevel(level: string): Promise<void> {
    try {
      if (!this.api) throw new Error("The host API is unavailable.");
      await this.api.models.thinking(this.session.id, level);
      this.update({ thinkingLevel: level });
    } catch (error) {
      this.update({ error: String(error) });
    }
  }

  async loadStats(): Promise<void> {
    try {
      if (!this.api) return;
      const data = await this.api.commands.raw(this.session.id, { type: "get_session_stats" });
      this.update({ stats: data && typeof data === "object" ? data as SessionStats : undefined });
    } catch { /* Session counters are ancillary; chat remains usable. */ }
  }

  async runCommand(command: string): Promise<void> {
    if (this.state.pending || this.state.projection.running) throw new Error("Wait for the current turn to settle before running a command.");
    await this.session.send({ clientMessageId: crypto.randomUUID(), text: command });
  }

  async abort(): Promise<void> {
    try { await this.session.interrupt(); }
    catch (error) { this.update({ error: String(error) }); }
  }

  async compactSession(_sessionPath?: string): Promise<void> {
    if (!this.api) throw new Error("The host API is unavailable.");
    await this.api.commands.compact(this.session.id);
    await this.refreshHistory();
  }

  async exportHtml(outputPath: string): Promise<void> {
    if (!this.api) throw new Error("The host API is unavailable.");
    await this.api.commands.exportHtml(this.session.id, outputPath);
  }

  async reloadSession(): Promise<void> {
    if (!this.api) throw new Error("The host API is unavailable.");
    await this.api.commands.reload(this.session.id, this.state.sessionFile);
    await this.refreshHistory();
    await this.loadModels();
  }

  async resumeSession(sessionPath: string): Promise<void> {
    if (!this.api) throw new Error("The host API is unavailable.");
    await this.api.commands.raw(this.session.id, { type: "switch_session", sessionPath });
    await this.refreshHistory();
    this.update({ sessionFile: sessionPath });
  }

  async reply(id: string, fields: WireObject): Promise<void> {
    if (!this.api) throw new Error("The host API is unavailable.");
    if (id.startsWith("a-")) {
      const decision = fields.cancelled === true ? "deny" : fields.confirmed === true ? "approve" : "deny";
      await this.api.prompts.approve(id, decision);
      return;
    }
    const answer = typeof fields.value === "string" ? fields.value : "";
    await this.api.prompts.answer(id, { q1: answer });
  }

  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.session.detach();
    this.listeners.clear();
    return this.session.stop().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.detach();
    this.onDispose?.();
    this.listeners.clear();
  }

  private fail(error: unknown): void {
    this.update({ connected: false, pending: false, error: String(error) });
  }

  private update(patch: Partial<ChatSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private async applyPreferredModel(): Promise<void> {
    const preferred = this.preferred;
    if (!preferred) return;
    if (this.state.modelProvider === preferred.provider && this.state.modelId === preferred.id) return;
    if (!this.state.models?.some(model => model.provider === preferred.provider && model.id === preferred.id)) {
      this.preferred = undefined;
      writeModelPreference(undefined);
      return;
    }
    try { await this.selectModel(preferred.provider, preferred.id); }
    catch {
      this.preferred = undefined;
      writeModelPreference(undefined);
    }
  }

  private requestDialog(data: Record<string, unknown>, method: "confirm" | "select" | "input"): void {
    const id = typeof data.approvalId === "string" ? data.approvalId
      : typeof data.questionId === "string" ? data.questionId : "";
    if (!id || !this.dialog) return;
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const first = questions[0] && typeof questions[0] === "object" ? questions[0] as Record<string, unknown> : {};
    const options = method === "confirm"
      ? ["Approve", "Deny"]
      : Array.isArray(first.options) ? first.options.filter((option): option is string => typeof option === "string") : [];
    const expiresAt = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
    this.dialog({
      type: "extension_ui_request",
      id,
      method,
      title: typeof data.tool === "string" ? data.tool : typeof first.header === "string" ? first.header : "Jouzu request",
      message: method === "confirm" && data.args && typeof data.args === "object"
        ? String((data.args as Record<string, unknown>).message ?? "")
        : typeof first.question === "string" ? first.question : "",
      options,
      timeout: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : undefined,
    }, this);
  }

  private handle(event: ApiEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "session.snapshot": {
        const empty = this.state.projection.messages.length === 0;
        this.update({
          sessionId: typeof data.sessionId === "string" ? data.sessionId : this.state.sessionId,
          sessionFile: typeof data.sessionPath === "string" ? data.sessionPath : this.state.sessionFile,
          model: typeof data.model === "string" ? data.model : this.state.model,
          thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : this.state.thinkingLevel,
          thinkingLevels: Array.isArray(data.thinkingLevels) ? data.thinkingLevels.filter((level): level is string => typeof level === "string") : this.state.thinkingLevels,
        });
        // The event stream may attach after the first turn already finished. Its
        // snapshot cursor is authoritative; reload the transcript instead of
        // waiting for live deltas that are already in the past.
        if (empty && typeof data.cursor === "number" && data.cursor > 0) void this.refreshHistory();
        break;
      }
      case "session.attached":
        this.update({ sessionFile: typeof data.sessionPath === "string" ? data.sessionPath : this.state.sessionFile });
        break;
      case "session.status":
        this.applyStatus(typeof data.status === "string" ? data.status : undefined);
        if (data.status === "stopped" || data.status === "error") this.update({ connected: false });
        break;
      case "turn.start":
        this.update({ pending: true, projection: { ...this.state.projection, running: true, turnStartedAt: Date.now() } });
        break;
      case "turn.end":
        this.update({ pending: false, projection: { ...this.state.projection, running: false, turnStartedAt: undefined } });
        break;
      case "message.accepted":
        this.update({ pending: true });
        break;
      case "message.start": {
        const messages = [...this.state.projection.messages, { role: "assistant", content: [], timestamp: Date.now() }];
        this.active = messages.length - 1;
        this.update({ projection: { ...this.state.projection, messages, activeMessage: this.active, running: true } });
        break;
      }
      case "message.delta": {
        const text = typeof data.text === "string" ? data.text : "";
        if (!text || this.active < 0) break;
        const thinking = data.kind === "thinking";
        const messages = this.state.projection.messages.map((message, index) => {
          if (index !== this.active) return message;
          const content = [...message.content];
          const blockIndex = content.findIndex(block => block.type === (thinking ? "thinking" : "text"));
          if (blockIndex < 0) content.push(thinking ? { type: "thinking", thinking: text } : { type: "text", text });
          else content[blockIndex] = thinking
            ? { ...content[blockIndex], thinking: `${content[blockIndex].thinking ?? ""}${text}` }
            : { ...content[blockIndex], text: `${content[blockIndex].text ?? ""}${text}` };
          return { ...message, content };
        });
        this.update({ projection: { ...this.state.projection, messages } });
        break;
      }
      case "message.done": {
        const blocks = Array.isArray(data.blocks) ? data.blocks : [];
        const messages = this.state.projection.messages.map((message, index) => index === this.active ? { ...message, content: blocks as never } : message);
        this.update({ pending: false, projection: { ...this.state.projection, messages, activeMessage: null, running: false } });
        this.active = -1;
        break;
      }
      case "tool.start": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
        if (!id) break;
        const tool: ToolView = { id, name: typeof data.toolName === "string" ? data.toolName : "tool", args: data.args, phase: "running" };
        this.update({ projection: { ...this.state.projection, tools: { ...this.state.projection.tools, [id]: tool } } });
        break;
      }
      case "tool.update": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
        const prior = this.state.projection.tools[id];
        if (!id || !prior) break;
        this.update({ projection: { ...this.state.projection, tools: { ...this.state.projection.tools, [id]: { ...prior, result: data.partialResult } } } });
        break;
      }
      case "tool.result": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
        const prior = this.state.projection.tools[id];
        if (!id) break;
        const tool: ToolView = {
          id,
          name: prior?.name ?? "tool",
          args: prior?.args,
          phase: data.ok === false ? "error" : "complete",
          result: data.result,
        };
        this.update({ projection: { ...this.state.projection, tools: { ...this.state.projection.tools, [id]: tool } } });
        break;
      }
      case "approval.requested":
        this.requestDialog(data, "confirm");
        break;
      case "question.requested": {
        const questions = Array.isArray(data.questions) ? data.questions : [];
        const first = questions[0] && typeof questions[0] === "object" ? questions[0] as Record<string, unknown> : {};
        const options = Array.isArray(first.options) ? first.options.filter((option): option is string => typeof option === "string") : [];
        this.requestDialog(data, options.length ? "select" : "input");
        break;
      }
      case "error":
        this.update({
          pending: false,
          error: typeof data.message === "string" ? data.message : "The runtime reported an error",
          projection: { ...this.state.projection, running: false },
        });
        break;
      default:
        break;
    }
  }

  private applyStatus(status: string | undefined): void {
    if (!status) return;
    const running = status === "running" || status === "waiting_approval" || status === "waiting_question";
    this.update({
      projection: {
        ...this.state.projection,
        running,
        turnStartedAt: running ? this.state.projection.turnStartedAt ?? Date.now() : undefined,
      },
    });
  }
}

const entryKey = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

/** Live stores, one per session path; the host owns the runtime behind them. */
export class SessionPool {
  private readonly entries = new Map<string, SessionStore>();
  private readonly watches = new Map<SessionStore, () => void>();
  private readonly statusListeners = new Set<() => void>();
  private statusSignature = "";
  private readonly maxSessions = 30;

  constructor(private readonly api: JouzuApi) {}

  client(sessionPath: string): SessionStore | undefined {
    const key = entryKey(sessionPath);
    const store = this.entries.get(key);
    if (!store) return undefined;
    if (store.isDisposed()) {
      this.entries.delete(key);
      this.unwatch(store);
      this.emitStatus();
      return undefined;
    }
    if (!store.snapshot.connected) {
      this.entries.delete(key);
      this.unwatch(store);
      void store.close();
      this.emitStatus();
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, store);
    this.watch(store);
    return store;
  }

  isRunning(sessionPath: string): boolean {
    const store = this.entries.get(entryKey(sessionPath));
    return !!store && store.snapshot.connected && store.snapshot.projection.running;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private watch(store: SessionStore): void {
    if (this.watches.has(store)) return;
    this.watches.set(store, store.subscribe(() => this.emitStatus()));
  }

  private unwatch(store: SessionStore): void {
    this.watches.get(store)?.();
    this.watches.delete(store);
  }

  private emitStatus(): void {
    const signature = [...this.entries]
      .map(([key, store]) => `${key}:${store.snapshot.connected && store.snapshot.projection.running ? 1 : 0}`)
      .sort()
      .join("|");
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    for (const listener of this.statusListeners) listener();
  }

  async lease(
    path: string,
    sessionPath?: string,
    dialog?: SessionDialog,
    _fresh = true,
  ): Promise<SessionStore> {
    return SessionStore.open(this.api, path, sessionPath, dialog);
  }

  async enter(path: string, sessionPath: string, dialog?: SessionDialog): Promise<SessionStore> {
    const key = entryKey(sessionPath);
    const cached = this.entries.get(key);
    if (cached && !cached.isDisposed() && cached.snapshot.connected) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.watch(cached);
      return cached;
    }
    if (cached) { this.entries.delete(key); this.unwatch(cached); void cached.close(); }
    const store = await this.lease(path, sessionPath, dialog, false);
    this.remember(sessionPath, store);
    return store;
  }

  forget(sessionPath: string): void {
    const key = entryKey(sessionPath);
    const store = this.entries.get(key);
    this.entries.delete(key);
    if (store) { this.unwatch(store); void store.close(); }
    this.emitStatus();
  }

  remember(sessionPath: string, store: SessionStore): void {
    const key = entryKey(sessionPath);
    const previous = this.entries.get(key);
    if (previous && previous !== store) {
      this.unwatch(previous);
      void previous.close();
    }
    this.entries.set(key, store);
    this.watch(store);
    this.emitStatus();
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted && evicted !== store) { this.unwatch(evicted); void evicted.close(); }
      this.emitStatus();
    }
  }
}

let sharedPool: SessionPool | undefined;

/** Called once by the app shell before ChatWorkspace mounts. */
export function configureSessionPool(api: JouzuApi): void {
  sharedPool = new SessionPool(api);
}

function pool(): SessionPool {
  if (!sharedPool) throw new Error("The session pool is not configured.");
  return sharedPool;
}

/** Stable facade used by ChatWorkspace; delegates to the configured pool. */
export const chatPool = {
  lease: (...args: Parameters<SessionPool["lease"]>) => pool().lease(...args),
  enter: (...args: Parameters<SessionPool["enter"]>) => pool().enter(...args),
  client: (path: string) => pool().client(path),
  isRunning: (path: string) => pool().isRunning(path),
  remember: (path: string, store: SessionStore) => pool().remember(path, store),
  forget: (path: string) => pool().forget(path),
  subscribeStatus: (listener: () => void) => pool().subscribeStatus(listener),
};
