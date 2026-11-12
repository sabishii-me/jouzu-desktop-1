/**
 * Host-backed session state for the UI.
 *
 * One Store owns one HostChatSession: attach, history, SSE, send and teardown.
 * The old ChatConnection/ChatPool/chat-transport path is being replaced by this
 * class; until the swap completes it exposes the ChatSnapshot shape the views
 * already consume.
 */
import { HostChatSession } from "./api/chat-session";
import type { ApiEvent, Attachment, HistoryPage, JouzuApi, Receipt } from "./api/jouzu-api";
import { emptyProjection, historyRowsProjection, type ChatProjection, type ToolView } from "./chat-projection";
import type { ChatSnapshot } from "./chat-connection";

export interface SessionPort {
  readonly id: string;
  history(page?: { limit?: number; before?: number }): Promise<HistoryPage>;
  send(message: { clientMessageId: string; text: string; attachments?: Attachment[] }): Promise<Receipt>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  detach(): void;
  follow(onEvent: (event: ApiEvent) => void, onError: (error: unknown) => void): void;
}

const emptySnapshot = (): ChatSnapshot => ({
  projection: emptyProjection(),
  connected: false,
  pending: false,
  error: null,
  models: [],
  thinkingLevels: [],
});

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class SessionStore {
  private state: ChatSnapshot = emptySnapshot();
  private readonly listeners = new Set<(state: ChatSnapshot) => void>();
  private active = -1;
  private disposed = false;

  private constructor(
    readonly session: SessionPort,
    private readonly onDispose?: () => void,
  ) {}

  static async open(api: JouzuApi, workspacePath: string, sessionPath?: string): Promise<SessionStore> {
    const session = await HostChatSession.open(api, workspacePath, sessionPath);
    const store = SessionStore.attach(session);
    await store.loadHistory();
    return store;
  }

  static attach(session: SessionPort, onDispose?: () => void): SessionStore {
    const store = new SessionStore(session, onDispose);
    store.state = { ...store.state, sessionId: session.id, connected: true };
    session.follow(event => store.handle(event), error => store.fail(error));
    return store;
  }

  snapshot(): ChatSnapshot {
    return this.state;
  }

  subscribe(listener: (state: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async loadHistory(): Promise<void> {
    const page = await this.session.history({ limit: 200 });
    this.active = -1;
    this.update({
      projection: historyRowsProjection(page.messages),
      historyError: undefined,
    });
  }

  async refreshHistory(): Promise<void> {
    await this.loadHistory();
  }

  async send(text: string, attachments: Attachment[] = [], clientMessageId: string = crypto.randomUUID()): Promise<Receipt> {
    this.update({ pending: true, error: null });
    try {
      return await this.session.send({ clientMessageId, text, attachments });
    } catch (error) {
      this.update({ pending: false, error: String(error) });
      throw error;
    }
  }

  interrupt(): Promise<void> {
    return this.session.interrupt();
  }

  async stop(): Promise<void> {
    this.session.detach();
    await this.session.stop();
    this.update({ connected: false });
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

  private handle(event: ApiEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "session.snapshot": {
        this.update({
          sessionId: typeof data.sessionId === "string" ? data.sessionId : this.state.sessionId,
          sessionFile: typeof data.sessionPath === "string" ? data.sessionPath : this.state.sessionFile,
          model: typeof data.model === "string" ? data.model : this.state.model,
          thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : this.state.thinkingLevel,
          thinkingLevels: Array.isArray(data.thinkingLevels) ? data.thinkingLevels.filter((level): level is string => typeof level === "string") : this.state.thinkingLevels,
        });
        break;
      }
      case "session.attached":
        this.update({ sessionFile: typeof data.sessionPath === "string" ? data.sessionPath : this.state.sessionFile });
        break;
      case "session.status":
        this.applyStatus(typeof data.status === "string" ? data.status : undefined);
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
        this.update({
          pending: false,
          projection: { ...this.state.projection, messages, activeMessage: null, running: false },
        });
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
