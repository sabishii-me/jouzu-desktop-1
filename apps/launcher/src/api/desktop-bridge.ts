/**
 * The desktop shell side of DesktopApi. This is the only UI-side module that
 * imports Tauri; it exposes native actions only. Host data never comes from
 * here.
 */

import { confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { NativeApi } from "./jouzu-api";

export interface DesktopBridge {
  native: NativeApi;
}

async function unavailable(): Promise<never> {
  throw new Error("This action is not available on the desktop shell yet.");
}

export function createDesktopBridge(): DesktopBridge {
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

  return { native };
}
