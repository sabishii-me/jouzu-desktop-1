import { describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createDesktopBridge } from "./desktop-bridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));

describe("DesktopBridge workspaces", () => {
  test("add uses the Tauri command and returns the refreshed recent list", async () => {
    const recent = [{ id: "windows:C:/work", path: "C:/work", environment: { kind: "windows" } }];
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "add_workspaces") return undefined as never;
      if (command === "launcher_state") return { ready: true, recent } as never;
      return undefined as never;
    });
    const bridge = createDesktopBridge();
    await expect(bridge.workspaces.add(["C:/work"])).resolves.toEqual(recent);
    expect(invoke).toHaveBeenCalledWith("add_workspaces", { paths: ["C:/work"] });
    expect(invoke).toHaveBeenCalledWith("launcher_state");
  });

  test("forget refreshes the recent list after the command", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "forget_workspace") return undefined as never;
      if (command === "launcher_state") return { recent: [] } as never;
      return undefined as never;
    });
    const bridge = createDesktopBridge();
    await expect(bridge.workspaces.forget("windows:C:/work")).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("forget_workspace", { id: "windows:C:/work" });
  });
});
