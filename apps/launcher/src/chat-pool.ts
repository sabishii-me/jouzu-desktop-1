import { ChatConnection } from "./chat-connection";
import type { WireObject } from "./chat-projection";
import { chatTransport } from "./chat-transport";

/**
 * Live session clients, one per session path.
 *
 * The host owns the runtime and the session, so there is no warm pool, no scratch
 * directory and no handle registry here: a client is just this page's subscription
 * to a host session. Switching away detaches nothing on the host.
 */
const entryKey = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

export class ChatPool {
  private entries = new Map<string, ChatConnection>();
  private watches = new Map<ChatConnection, () => void>();
  private statusListeners = new Set<() => void>();
  private statusSignature = "";
  private disposed = false;

  constructor(private readonly maxSessions = 30) {}

  /** The live client for `sessionPath`, when one is already open. */
  client(sessionPath: string): ChatConnection | undefined {
    const key = entryKey(sessionPath);
    const client = this.entries.get(key);
    if (!client) return undefined;
    if (client.isDisposed()) {
      this.entries.delete(key);
      this.unwatch(client);
      this.emitStatus();
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, client);
    this.watch(client);
    return client;
  }

  isRunning(sessionPath: string): boolean {
    const client = this.entries.get(entryKey(sessionPath));
    return !!client && client.snapshot.connected && client.snapshot.projection.running;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private watch(client: ChatConnection): void {
    if (this.watches.has(client)) return;
    this.watches.set(client, client.subscribe(() => this.emitStatus()));
  }

  private unwatch(client: ChatConnection): void {
    this.watches.get(client)?.();
    this.watches.delete(client);
  }

  private emitStatus(): void {
    const signature = [...this.entries]
      .map(([key, client]) => `${key}:${client.snapshot.connected && client.snapshot.projection.running ? 1 : 0}`)
      .sort()
      .join("|");
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    for (const listener of this.statusListeners) listener();
  }

  /** Nothing to pre-start: the host attaches a session when a client asks for one. */
  async warm(): Promise<void> {}

  /** Open a session; without a session path this starts a new one in the workspace. */
  async lease(
    path: string,
    sessionPath?: string,
    dialog?: (request: WireObject, client: ChatConnection) => void,
    fresh = true,
  ): Promise<ChatConnection> {
    const client = new ChatConnection(() => {}, dialog ?? (() => {}), chatTransport());
    await client.start(path, fresh && !sessionPath, `session:${entryKey(sessionPath ?? path)}`);
    return client;
  }

  /** A live session client kept across view switches; LRU-bounded by maxSessions. */
  async enter(
    path: string,
    sessionPath: string,
    dialog?: (request: WireObject, client: ChatConnection) => void,
  ): Promise<ChatConnection> {
    const key = entryKey(sessionPath);
    const cached = this.entries.get(key);
    if (cached && !cached.isDisposed()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.watch(cached);
      return cached;
    }
    if (cached) this.entries.delete(key);
    const client = await this.lease(path, sessionPath, dialog, false);
    this.remember(sessionPath, client);
    return client;
  }

  /** Drop a dead entry after its session was replaced. */
  forget(sessionPath: string): void {
    const key = entryKey(sessionPath);
    const client = this.entries.get(key);
    this.entries.delete(key);
    if (client) { this.unwatch(client); void client.close(); }
    this.emitStatus();
  }

  /** Keep an existing client under its session path so switching back is instant. */
  remember(sessionPath: string, client: ChatConnection): void {
    const key = entryKey(sessionPath);
    const previous = this.entries.get(key);
    if (previous && previous !== client) {
      this.unwatch(previous);
      void previous.close();
    }
    this.entries.set(key, client);
    this.watch(client);
    this.emitStatus();
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted && evicted !== client) { this.unwatch(evicted); void evicted.close(); }
      this.emitStatus();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const client of this.entries.values()) this.unwatch(client);
    this.entries.clear();
    this.statusListeners.clear();
  }
}

/** One pool per window: the workspace view keeps a client per open session. */
export const chatPool = new ChatPool();