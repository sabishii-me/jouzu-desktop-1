/**
 * The only interface the UI depends on. Platform implementations are siblings
 * (DesktopApi / WebApi / RemoteApi); components never import Tauri or fetch
 * host endpoints directly.
 *
 * See docs/adr/0009 and docs/contracts/jouzu-api-v1.md.
 */

export type Unsubscribe = () => void;

export interface ApiCapabilities {
  host: boolean;
  native: boolean;
  features: string[];
  scopes: string[];
}

export type ApiErrorCode =
  | "capability-unavailable"
  | "unauthorized"
  | "forbidden"
  | "invalid-request"
  | "session-not-found"
  | "prompt-resolved"
  | "prompt-expired"
  | "runtime-unavailable"
  | "runtime-error"
  | "runtime-timeout"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class CapabilityUnavailable extends ApiError {
  constructor(message = "This action is not available on this platform.") {
    super("capability-unavailable", message, false);
    this.name = "CapabilityUnavailable";
  }
}

export interface SessionSummary {
  sessionId: string | null;
  sessionPath: string | null;
  workspacePath: string;
  title: string;
  status: string;
  updatedAt?: string;
  running: boolean;
  pinned: boolean;
  archived: boolean;
  pendingApprovals?: number;
  pendingQuestions?: number;
}

export interface SessionHandle {
  sessionId: string;
  workspacePath: string;
  sessionPath: string | null;
  status: string;
  cursor: number;
}

export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface OutgoingMessage {
  clientMessageId: string;
  text: string;
  clientId?: string;
  attachments?: Attachment[];
}

export interface Receipt {
  messageId: string;
  receipt: string;
}

export interface HistoryRow {
  cursor: number;
  id: string;
  kind: "user" | "assistant" | "tool" | string;
  text?: string;
  turnId?: string;
  createdAt?: string;
  attachments?: Attachment[];
  tool?: { name: string; callId: string; status: string };
  args?: unknown;
  result?: unknown;
}

export interface HistoryPage {
  messages: HistoryRow[];
  nextBefore: number | null;
}

export interface SessionTiming {
  modelMs: number;
  toolMs: number;
  turns: number;
  steps: number;
  outputTokens: number;
}

export interface Workspace {
  id: string;
  path: string;
  environment: { kind: string };
}

export interface Model {
  id: string;
  name: string;
  provider: string;
}

export interface RuntimeStatus {
  hostVersion: string;
  runtimeHome: string;
  appVersion?: string | null;
  node: boolean;
  app: boolean;
  bash: boolean;
  git: boolean;
  terminal: boolean;
}

export interface Artifact {
  id: string;
  kind: string;
  mimeType: string;
  absolutePath?: string;
  createdAt?: string;
  source?: { sessionId?: string };
  [key: string]: unknown;
}

export interface ArtifactBody {
  record: Artifact;
  mimeType: string;
  data: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface EnvironmentEntry {
  name: string;
  value: string;
  enabled: boolean;
}

export interface SessionApi {
  list(): Promise<SessionSummary[]>;
  attach(workspacePath: string, sessionPath?: string): Promise<SessionHandle>;
  history(sessionId: string, page?: { limit?: number; before?: number }): Promise<HistoryPage>;
  messages(sessionPath: string, limit?: number): Promise<unknown[]>;
  send(sessionId: string, message: OutgoingMessage): Promise<Receipt>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  update(sessionPath: string, change: { pinned?: boolean; archived?: boolean; title?: string }): Promise<SessionSummary | unknown>;
  branch(sessionPath: string, messageIndex: number): Promise<string>;
  recover(sessionPath: string): Promise<string | null>;
  timing(sessionPath: string): Promise<SessionTiming>;
  flowReports(sessionPath: string): Promise<Array<{ kind: string; text: string }>>;
}

export interface PromptApi {
  approve(approvalId: string, decision: string): Promise<void>;
  answer(questionId: string, answers: Record<string, string>): Promise<void>;
}

export interface RuntimeApi {
  status(): Promise<RuntimeStatus>;
  components(): Promise<Record<string, unknown>>;
  diagnostics(): Promise<unknown | null>;
}

export interface WorkspaceApi {
  list(): Promise<Workspace[]>;
  add(paths: string[]): Promise<Workspace[]>;
  forget(id: string): Promise<Workspace[]>;
}

export interface ModelApi {
  list(sessionId: string): Promise<Model[]>;
  select(sessionId: string, provider: string, model: string): Promise<void>;
  thinking(sessionId: string, level: string): Promise<void>;
}

export interface CommandApi {
  run(sessionId: string, command: string): Promise<void>;
  compact(sessionId: string): Promise<void>;
  exportHtml(sessionId: string, outputPath: string): Promise<void>;
  reload(sessionId: string): Promise<void>;
}

export interface ArtifactApi {
  list(options?: { kind?: string; sessionId?: string }): Promise<Artifact[]>;
  read(id: string): Promise<ArtifactBody>;
  delete(id: string): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

export interface FileApi {
  list(path: string): Promise<FileEntry[]>;
  reveal(path: string): Promise<void>;
}

export interface SettingsApi {
  environment: {
    read(): Promise<EnvironmentEntry[]>;
    save(entries: EnvironmentEntry[]): Promise<void>;
  };
  control(request: unknown): Promise<unknown>;
}

export interface NativeApi {
  confirm(options: { message: string; title?: string }): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  terminal(path?: string): Promise<void>;
  installTerminal(): Promise<void>;
  updater: {
    check(): Promise<unknown>;
    install(): Promise<void>;
  };
}

export interface ApiEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

export abstract class JouzuApi {
  abstract readonly capabilities: ApiCapabilities;
  abstract readonly sessions: SessionApi;
  abstract readonly prompts: PromptApi;
  abstract readonly runtime: RuntimeApi;
  abstract readonly workspaces: WorkspaceApi;
  abstract readonly models: ModelApi;
  abstract readonly commands: CommandApi;
  abstract readonly artifacts: ArtifactApi;
  abstract readonly files: FileApi;
  abstract readonly settings: SettingsApi;
  abstract readonly native: NativeApi;

  abstract start(): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
}
