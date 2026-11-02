/**
 * The desktop shell side of DesktopApi. This is the only UI-side module that
 * imports Tauri; components consume JouzuApi instead.
 */

import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  Artifact,
  ArtifactBody,
  ArtifactApi,
  FileApi,
  FileEntry,
  NativeApi,
  SettingsApi,
  EnvironmentEntry,
  Workspace,
  WorkspaceApi,
} from "./jouzu-api";

export interface DesktopBridge {
  artifacts: ArtifactApi;
  files: FileApi;
  settings: SettingsApi;
  native: NativeApi;
  workspaces: WorkspaceApi;
}

async function unavailable(): Promise<never> {
  throw new Error("This action is not available on the desktop shell yet.");
}

export function createDesktopBridge(): DesktopBridge {
  async function launcherWorkspaces(): Promise<Workspace[]> {
    const state = await invoke<{ recent?: Workspace[] }>("launcher_state");
    return state.recent ?? [];
  }

  const workspaces: WorkspaceApi = {
    list: launcherWorkspaces,
    async add(paths) {
      await invoke("add_workspaces", { paths });
      return launcherWorkspaces();
    },
    async forget(id) {
      await invoke("forget_workspace", { id });
      return launcherWorkspaces();
    },
  };

  const artifacts: ArtifactApi = {
    async list(options = {}) {
      const result = await invoke<{ artifacts: Artifact[] }>("artifact_list", {
        kind: options.kind,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
      return result.artifacts ?? [];
    },
    read: id => invoke<ArtifactBody>("artifact_read", { id }),
    async delete(id) {
      await invoke("artifact_delete", { id });
    },
    counts: async () => {
      const result = await invoke<{ counts: Record<string, number> }>("artifact_counts");
      return result.counts ?? {};
    },
  };

  const files: FileApi = {
    async list(path) {
      const result = await invoke<{ entries: FileEntry[] }>("workspace_list", { path });
      return result.entries ?? [];
    },
    async reveal(path) {
      await invoke("reveal_path", { path });
    },
  };

  const settings: SettingsApi = {
    environment: {
      read: () => invoke<EnvironmentEntry[]>("environment_read"),
      async save(entries) {
        await invoke("environment_save", { entries });
      },
    },
    control: request => invoke("control_request", { request }),
  };

  const native: NativeApi = {
    async confirm(options) {
      return confirm(options.message, { title: options.title, kind: "warning" });
    },
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : null;
    },
    reveal: async path => {
      await revealItemInDir(path);
    },
    openExternal: async url => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    terminal: unavailable,
    installTerminal: unavailable,
    updater: {
      check: unavailable,
      install: unavailable,
    },
  };

  return { artifacts, files, settings, native, workspaces };
}
