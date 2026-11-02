/**
 * Thin HTTP client for the host `/v1` contract. Platform adapters compose this;
 * UI components never see it.
 */

import {
  ApiError,
  type ApiCapabilities,
  type Artifact,
  type ArtifactBody,
  type Attachment,
  type FileEntry,
  type HistoryPage,
  type Receipt,
  type RuntimeStatus,
  type SessionHandle,
  type SessionSummary,
  type Workspace,
} from "./jouzu-api";

export interface HostClientOptions {
  baseUrl?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; retryable?: boolean };
}

export class HostClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly clientId: string;

  constructor(options: HostClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clientId = options.clientId ?? `web-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      credentials: "same-origin",
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const envelope = body as ErrorEnvelope | null;
      throw new ApiError(
        (envelope?.error?.code as ApiError["code"]) ?? "internal",
        envelope?.error?.message ?? `Host request failed (${response.status})`,
        envelope?.error?.retryable ?? false,
        response.status,
      );
    }
    return body as T;
  }

  capabilities(): Promise<ApiCapabilities> {
    return this.request<ApiCapabilities>("/v1/capabilities");
  }

  status(): Promise<RuntimeStatus> {
    return this.request<RuntimeStatus>("/v1/status");
  }

  async sessions(): Promise<SessionSummary[]> {
    const [live, persisted] = await Promise.all([
      this.request<{ sessions: SessionSummary[] }>("/v1/sessions"),
      this.request<{ sessions: SessionSummary[] }>("/v1/sessions/persisted"),
    ]);
    const byPath = new Map<string, SessionSummary>();
    for (const session of [...persisted.sessions, ...live.sessions]) {
      const key = (session.sessionPath ?? session.sessionId ?? session.workspacePath)
        .replace(/^\\\\\?\\/u, "")
        .toLowerCase();
      byPath.set(key, session);
    }
    return [...byPath.values()];
  }

  attach(workspacePath: string, sessionPath?: string): Promise<SessionHandle> {
    return this.request<SessionHandle>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ workspacePath, sessionPath: sessionPath ?? null }),
    });
  }

  history(sessionId: string, page: { limit?: number; before?: number } = {}): Promise<HistoryPage> {
    const query = new URLSearchParams();
    if (page.limit) query.set("limit", String(page.limit));
    if (page.before) query.set("before", String(page.before));
    return this.request<HistoryPage>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
    );
  }

  messages(sessionPath: string, limit?: number): Promise<unknown[]> {
    const query = new URLSearchParams({ sessionPath });
    if (limit) query.set("limit", String(limit));
    return this.request<{ messages: unknown[] }>(`/v1/sessions/messages?${query}`)
      .then(body => body.messages);
  }

  send(sessionId: string, text: string, clientMessageId: string, attachments: Attachment[] = []): Promise<Receipt> {
    const body: Record<string, unknown> = { clientMessageId, text, clientId: this.clientId };
    if (attachments.length) body.attachments = attachments;
    return this.request<Receipt>(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  command(sessionId: string, command: Record<string, unknown>): Promise<unknown> {
    return this.request<{ data: unknown }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/command`,
      { method: "POST", body: JSON.stringify(command) },
    ).then(body => body.data);
  }

  interrupt(sessionId: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
  }

  stop(sessionId: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  }

  updateSession(sessionPath: string, change: { pinned?: boolean; archived?: boolean; title?: string }): Promise<unknown> {
    return this.request("/v1/sessions/update", {
      method: "POST",
      body: JSON.stringify({ sessionPath, ...change }),
    });
  }

  branch(sessionPath: string, messageIndex: number): Promise<string> {
    return this.request<{ sessionPath: string }>("/v1/sessions/branch", {
      method: "POST",
      body: JSON.stringify({ sessionPath, messageIndex }),
    }).then(body => body.sessionPath);
  }

  recover(sessionPath: string): Promise<string | null> {
    return this.request<{ sessionPath: string | null }>("/v1/sessions/recover", {
      method: "POST",
      body: JSON.stringify({ sessionPath }),
    }).then(body => body.sessionPath);
  }

  timing(sessionPath: string): Promise<unknown> {
    return this.request<{ timing: unknown }>(
      `/v1/sessions/timing?sessionPath=${encodeURIComponent(sessionPath)}`,
    ).then(body => body.timing);
  }

  flowReports(sessionPath: string): Promise<unknown[]> {
    return this.request<{ reports: unknown[] }>(
      `/v1/sessions/flow?sessionPath=${encodeURIComponent(sessionPath)}`,
    ).then(body => body.reports);
  }

  approve(approvalId: string, decision: string): Promise<unknown> {
    return this.request(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      body: JSON.stringify({ clientId: this.clientId, decision }),
    });
  }

  answer(questionId: string, answers: Record<string, string>): Promise<unknown> {
    return this.request(`/v1/questions/${encodeURIComponent(questionId)}/answer`, {
      method: "POST",
      body: JSON.stringify({ clientId: this.clientId, answers }),
    });
  }

  workspaces(): Promise<Workspace[]> {
    return this.request<{ workspaces: Workspace[] }>("/v1/workspaces")
      .then(body => body.workspaces);
  }

  addWorkspaces(paths: string[]): Promise<Workspace[]> {
    return this.request<{ workspaces: Workspace[] }>("/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }).then(body => body.workspaces);
  }

  forgetWorkspace(id: string): Promise<Workspace[]> {
    return this.request<{ workspaces: Workspace[] }>("/v1/workspaces/forget", {
      method: "POST",
      body: JSON.stringify({ id }),
    }).then(body => body.workspaces);
  }

  artifacts(options: { kind?: string; sessionId?: string } = {}): Promise<Artifact[]> {
    const query = new URLSearchParams();
    if (options.kind) query.set("kind", options.kind);
    if (options.sessionId) query.set("sessionId", options.sessionId);
    return this.request<{ artifacts: Artifact[] }>(`/v1/artifacts?${query}`)
      .then(body => body.artifacts);
  }

  artifactCounts(): Promise<Record<string, number>> {
    return this.request<{ counts: Record<string, number> }>("/v1/artifacts/counts")
      .then(body => body.counts);
  }

  artifact(id: string): Promise<ArtifactBody> {
    return this.request<ArtifactBody>(`/v1/artifacts/${encodeURIComponent(id)}`);
  }

  deleteArtifact(id: string): Promise<void> {
    return this.request<void>(`/v1/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  files(path: string): Promise<FileEntry[]> {
    return this.request<{ entries: FileEntry[] }>(
      `/v1/files?path=${encodeURIComponent(path)}`,
    ).then(body => body.entries);
  }
}
