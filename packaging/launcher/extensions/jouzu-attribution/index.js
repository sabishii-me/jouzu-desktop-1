// Jouzu Desktop: "Mark commits made by the agent" (Settings > Tools, off by
// default). Installed into the agent's extension directory by the desktop; it
// is not part of the runtime.
//
// While it is on:
// - git started by the agent's shell tools uses the hooks beside this file
//   (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, appended after
//   any git configuration the runtime started with). Each hook runs the
//   repository's own hook first; `prepare-commit-msg` then adds
//   `Co-authored-by: Jouzu Desktop (<model>) <noreply@shisa.ai>` and
//   `Jouzu-Session: <session id>` from the PI_MODEL / PI_SESSION_ID the shell
//   tools give every command.
// - the agent is asked to end pull request descriptions with a line naming
//   Jouzu Desktop and its model. That one is an instruction, not enforced.
//
// The setting is read for every tool call and every run, so turning it on or
// off applies at once, in open sessions too. It marks commits; it does not
// prove who made them.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Every hook git runs from a hooks folder, so a repository's own hooks keep running. */
export const HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "post-index-change", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
];

export function home() {
  return process.env.JOUZU_HOME || join(process.env.LOCALAPPDATA || process.cwd(), "Shisa.ai", "JouzuDesktop", "data");
}

/** On only when the person turned it on; anything unreadable is off. */
export function enabled(root = home()) {
  try {
    return JSON.parse(readFileSync(join(root, "agent", "tools.json"), "utf8"))?.commitAttribution?.enabled === true;
  } catch {
    return false;
  }
}

/** Write the hooks as this extension ships them; a file already right is left alone. */
export function installHooks(directory = join(HERE, "hooks")) {
  const script = readFileSync(join(HERE, "hook.sh"), "utf8");
  mkdirSync(directory, { recursive: true });
  for (const name of HOOKS) {
    const file = join(directory, name);
    let current = null;
    try { current = readFileSync(file, "utf8"); } catch { /* not written yet */ }
    if (current === script) continue;
    const temp = join(directory, `.${name}.tmp`);
    writeFileSync(temp, script);
    chmodSync(temp, 0o755);
    renameSync(temp, file);
  }
  return directory;
}

/**
 * Point the shell tools' git at our hooks, or take that back. `env` is the
 * runtime's own environment, which the shell tools copy for every command;
 * `original` is its GIT_CONFIG_COUNT before we touched it.
 */
export function applyTo(env, on, original, hooks) {
  // `hooks`: the hooks folder, needed only when on.
  const parsed = Number.parseInt(original ?? "0", 10);
  const index = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  if (on) {
    env[`GIT_CONFIG_KEY_${index}`] = "core.hooksPath";
    env[`GIT_CONFIG_VALUE_${index}`] = hooks;
    env.GIT_CONFIG_COUNT = String(index + 1);
    // The hooks switch this entry off for one git call to find the repository's own hooks.
    env.JOUZU_GIT_HOOKS_INDEX = String(index);
  } else if (env.JOUZU_GIT_HOOKS_INDEX !== undefined) {
    delete env[`GIT_CONFIG_KEY_${index}`];
    delete env[`GIT_CONFIG_VALUE_${index}`];
    if (original === undefined) delete env.GIT_CONFIG_COUNT;
    else env.GIT_CONFIG_COUNT = original;
    delete env.JOUZU_GIT_HOOKS_INDEX;
  }
}

export function guideline(model) {
  const name = model?.name || model?.id;
  const line = name ? `Generated with Jouzu Desktop (${name})` : "Generated with Jouzu Desktop";
  return `When you create a pull request or merge request (for example with gh pr create), end its description with a blank line and then the line "${line}".`;
}

export default function (pi) {
  const original = process.env.GIT_CONFIG_COUNT;
  let hooks = null;

  pi.on("tool_call", event => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    const on = enabled();
    try {
      applyTo(process.env, on, original, on ? (hooks ??= installHooks()) : undefined);
    } catch {
      // The hooks could not be written: commits go unmarked rather than failing.
      applyTo(process.env, false, original);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (!Array.isArray(guidelines)) return;
    const ours = guidelines.findIndex(text => typeof text === "string" && text.includes("Generated with Jouzu Desktop"));
    if (ours >= 0) guidelines.splice(ours, 1);
    if (enabled()) guidelines.push(guideline(ctx?.model));
  });
}
