// Jouzu Desktop: "Mark commits made by the agent" (Settings > Collaboration, off by
// default). Installed into the agent's extension directory by the desktop; it
// is not part of the runtime.
//
// While it is on:
// - git started by the agent's shell tools uses the hooks beside this file
//   (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, appended after
//   any git configuration the runtime started with). Each hook runs the
//   repository's own hook first; `prepare-commit-msg` then adds
//   `Co-authored-by: Jouzu Desktop (<model>) <359074535+jouzu-desktop@users.noreply.github.com>` and
//   `Jouzu-Session: <session id>` from the PI_MODEL / PI_SESSION_ID the shell
//   tools give every command.
// - the agent is asked to end pull request descriptions with a line naming
//   Jouzu Desktop and its model. That one is an instruction, not enforced.
// - if "Commit as Jouzu Desktop" is on too, new commits the agent makes have
//   Jouzu Desktop as their author (GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL), so
//   GitHub counts them for the jouzu-desktop account. The committer stays the
//   person's own git identity (and signing key), and `prepare-commit-msg` adds
//   the person as `Co-authored-by`. Amend, rebase and cherry-pick keep the
//   author a commit already has.
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

/** The agent's commit author while "Commit as Jouzu Desktop" is on. */
export const AUTHOR = { name: "Jouzu Desktop", email: "359074535+jouzu-desktop@users.noreply.github.com" };

/**
 * What the person turned on; anything unreadable is off. `author` counts only
 * while marking is on.
 */
export function settings(root = home()) {
  try {
    const value = JSON.parse(readFileSync(join(root, "agent", "attribution.json"), "utf8"));
    const on = value?.enabled === true;
    return { enabled: on, author: on && value?.author === true };
  } catch {
    return { enabled: false, author: false };
  }
}

export function enabled(root = home()) {
  return settings(root).enabled;
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
export function applyTo(env, on, original, hooks, kept = {}) {
  // `on`: settings() or a boolean (marking only). `hooks`: the hooks folder,
  // needed only when on. `kept`: where the person's own author is kept while
  // we replace it.
  if (on === false || on === true) on = { enabled: on, author: false };
  const parsed = Number.parseInt(original ?? "0", 10);
  const index = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  setAuthor(env, on.enabled && on.author, kept);
  if (on.enabled) {
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

/**
 * Make Jouzu Desktop the author of new commits, or give the runtime's own
 * author back. `kept` holds what GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL were
 * before we touched them (undefined when unset).
 */
function setAuthor(env, on, kept) {
  if (on) {
    if (env.JOUZU_GIT_AUTHOR !== "1") {
      kept.name = env.GIT_AUTHOR_NAME;
      kept.email = env.GIT_AUTHOR_EMAIL;
    }
    env.GIT_AUTHOR_NAME = AUTHOR.name;
    env.GIT_AUTHOR_EMAIL = AUTHOR.email;
    // Marks that the author is ours, so turning it off gives the person's back.
    env.JOUZU_GIT_AUTHOR = "1";
  } else if (env.JOUZU_GIT_AUTHOR === "1") {
    restore(env, "GIT_AUTHOR_NAME", kept.name);
    restore(env, "GIT_AUTHOR_EMAIL", kept.email);
    delete env.JOUZU_GIT_AUTHOR;
  }
}

function restore(env, key, value) {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

export function guideline(model) {
  const name = model?.name || model?.id;
  const line = name ? `Generated with Jouzu Desktop (${name})` : "Generated with Jouzu Desktop";
  return `When you create a pull request or merge request (for example with gh pr create), end its description with a blank line and then the line "${line}".`;
}

export default function (pi) {
  const original = process.env.GIT_CONFIG_COUNT;
  const kept = {};
  let hooks = null;

  pi.on("tool_call", event => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    const on = settings();
    try {
      applyTo(process.env, on, original, on.enabled ? (hooks ??= installHooks()) : undefined, kept);
    } catch {
      // The hooks could not be written: commits go unmarked rather than failing.
      applyTo(process.env, false, original, undefined, kept);
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
