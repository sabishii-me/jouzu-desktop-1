/**
 * Sibling platform adapters. They all extend JouzuApi directly; components only
 * see the abstract parent. Platform differences are capabilities, not UI branches.
 */

import { HostClient } from "./host-client";
import {
  ApiError,
  CapabilityUnavailable,
  JouzuApi,
  type ApiCapabilities,
  type ApiEvent,
  type ArtifactApi,
  type CommandApi,
  type FileApi,
  type Model,
  type ModelApi,
  type NativeApi,
  type PromptApi,
  type RuntimeApi,
  type SessionApi,
  type SettingsApi,
  type Unsubscribe,
  type WorkspaceApi,
} from "./jouzu-api";

function unsupported(): never {
  throw new ApiError("invalid-request", "This host method is not implemented yet.", false);
}

function unavailableNative(): NativeApi {
  const fail = async (): Promise<never> => {
    throw new CapabilityUnavailable();
  };
  return {
    pickFolder: fail,
    reveal: fail,
    openExternal: fail,
    terminal: fail,
    installTerminal: fail,
    updater: { check: fail, install: fail },
  };
}

function hostGroups(client: HostClient) {
  const sessions: SessionApi = {
    list: () => client.sessions(),
    attach: (workspacePath, sessionPath) => client.attach(workspacePath, sessionPath),
    history: (sessionId, page) => client.history(sessionId, page),
    messages: (sessionPath, limit) => client.messages(sessionPath, limit),
    send: (sessionId, message) =>
      client.send(sessionId, message.text, message.clientMessageId, message.attachments ?? []),
    async interrupt(sessionId) {
      await client.interrupt(sessionId);
    },
    async stop(sessionId) {
      await client.stop(sessionId);
    },
    update: (sessionPath, change) => client.updateSession(sessionPath, change),
    branch: (sessionPath, messageIndex) => client.branch(sessionPath, messageIndex),
    recover: sessionPath => client.recover(sessionPath),
    timing: async sessionPath => (await client.timing(sessionPath)) as never,
    flowReports: async sessionPath => (await client.flowReports(sessionPath)) as never,
  };

  const prompts: PromptApi = {
    async approve(approvalId, decision) {
      await client.approve(approvalId, decision);
    },
    async answer(questionId, answers) {
      await client.answer(questionId, answers);
    },
  };

  const runtime: RuntimeApi = {
    status: () => client.status(),
    components: async () => ({}),
    diagnostics: async () => null,
  };

  const workspaces: WorkspaceApi = {
    list: () => client.workspaces(),
    add: paths => client.addWorkspaces(paths),
    forget: id => client.forgetWorkspace(id),
  };

  const models: ModelApi = {
    async list(sessionId) {
      const data = (await client.command(sessionId, { type: "get_available_models" })) as {
        models?: Model[];
      };
      return data?.models ?? [];
    },
    async select(sessionId, provider, model) {
      await client.command(sessionId, { type: "set_model", provider, modelId: model });
    },
    async thinking(sessionId, level) {
      await client.command(sessionId, { type: "set_thinking_level", level });
    },
  };

  const commands: CommandApi = {
    async run(sessionId, command) {
      await client.send(sessionId, command, `cmd-${crypto.randomUUID()}`);
    },
    async compact(sessionId) {
      await client.command(sessionId, { type: "compact" });
    },
    async exportHtml(sessionId, outputPath) {
      await client.command(sessionId, { type: "export_html", outputPath });
    },
    async reload() {
      unsupported();
    },
  };

  const artifacts: ArtifactApi = {
    list: options => client.artifacts(options),
    read: id => client.artifact(id),
    async delete(id) {
      await client.deleteArtifact(id);
    },
    counts: () => client.artifactCounts(),
  };

  const files: FileApi = {
    list: path => client.files(path),
    async reveal() {
      throw new CapabilityUnavailable();
    },
  };

  const settings: SettingsApi = {
    environment: {
      read: () => client.environment(),
      async save(entries) {
        await client.saveEnvironment(entries);
      },
    },
    async control() {
      unsupported();
    },
  };

  return {
    sessions,
    prompts,
    runtime,
    workspaces,
    models,
    commands,
    artifacts,
    files,
    settings,
    native: unavailableNative(),
  };
}

function assignHostGroups(api: JouzuApi, client: HostClient): void {
  Object.assign(api as unknown as Record<string, unknown>, hostGroups(client));
}

export class WebApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["sse", "replay", "prompts", "history-paging"],
    scopes: ["loopback"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient) {
    super();
    assignHostGroups(this, client);
  }

  async start(): Promise<void> {
    await this.client.capabilities();
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export class RemoteApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["sse", "replay", "prompts", "history-paging"],
    scopes: ["lan", "tailnet"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient) {
    super();
    assignHostGroups(this, client);
  }

  async start(): Promise<void> {
    await this.client.capabilities();
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export class DesktopApi extends JouzuApi {
  readonly capabilities: ApiCapabilities = {
    host: true,
    native: false,
    features: ["sse", "replay", "prompts", "history-paging"],
    scopes: ["loopback"],
  };
  readonly sessions!: SessionApi;
  readonly prompts!: PromptApi;
  readonly runtime!: RuntimeApi;
  readonly workspaces!: WorkspaceApi;
  readonly models!: ModelApi;
  readonly commands!: CommandApi;
  readonly artifacts!: ArtifactApi;
  readonly files!: FileApi;
  readonly settings!: SettingsApi;
  readonly native!: NativeApi;

  constructor(readonly client: HostClient) {
    super();
    assignHostGroups(this, client);
  }

  async start(): Promise<void> {
    await this.client.capabilities();
  }

  async dispose(): Promise<void> {}

  subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return this.client.subscribe(sessionId, clientId, capabilities, cursor, onEvent, onError);
  }
}

export function createJouzuApi(client = new HostClient()): JouzuApi {
  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    return new DesktopApi(client);
  }
  return new WebApi(client);
}
