import { invoke } from "@tauri-apps/api/core";

/**
 * File actions for paths that appear in the transcript (0057). Revealing is a
 * native command so the path policy cannot be bypassed from the webview, and it
 * never launches file contents.
 */

export type RevealFailure = "not-absolute" | "not-found" | "not-a-file" | "outside-workspace" | "reveal-failed";

const MESSAGES: Record<RevealFailure, string> = {
  "not-absolute": "That path is relative and has no workspace.",
  "not-found": "File not found",
  "not-a-file": "Not a file",
  "outside-workspace": "Outside the workspace",
  "reveal-failed": "Could not reveal",
};

export function revealMessage(reason: string | undefined): string {
  return MESSAGES[(reason ?? "") as RevealFailure] ?? "Could not reveal";
}

function failureReason(error: unknown): RevealFailure {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const normalized = text.toLowerCase().replace(/[\s_]+/gu, "-");
  return (Object.keys(MESSAGES) as RevealFailure[]).find(key => normalized.includes(key)) ?? "reveal-failed";
}

/** One in-flight reveal per path, so a double click cannot spawn two shells. */
const pending = new Set<string>();

export async function revealPath(path: string, workspace?: string): Promise<void> {
  if (pending.has(path)) return;
  pending.add(path);
  try {
    await invoke("reveal_path", workspace ? { path, workspace } : { path });
  } catch (error) {
    throw new Error(revealMessage(failureReason(error)));
  } finally {
    pending.delete(path);
  }
}

export async function copyPath(path: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(path);
    return true;
  } catch {
    return false;
  }
}