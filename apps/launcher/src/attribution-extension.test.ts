// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { HOOKS, applyTo, enabled, guideline, installHooks } from "../../../packaging/launcher/extensions/jouzu-attribution/index.js";

const temps: string[] = [];
function temp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function homeWith(tools?: unknown) {
  const home = temp("jouzu-attr-home-");
  mkdirSync(join(home, "agent"), { recursive: true });
  if (tools !== undefined) writeFileSync(join(home, "agent", "tools.json"), JSON.stringify(tools));
  return home;
}

describe("jouzu-attribution extension", () => {
  it("is off unless tools.json turns it on", () => {
    expect(enabled(homeWith())).toBe(false);
    expect(enabled(homeWith({ image: {} }))).toBe(false);
    expect(enabled(homeWith({ commitAttribution: { enabled: "yes" } }))).toBe(false);
    expect(enabled(homeWith({ commitAttribution: { enabled: true } }))).toBe(true);
  });

  it("appends its git configuration after the runtime's own and takes it back", () => {
    const env = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2" };
    applyTo(env, true, "2", "/hooks");
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/hooks", JOUZU_GIT_HOOKS_INDEX: "2", GIT_CONFIG_KEY_0: "a.b" });
    applyTo(env, false, "2");
    expect(env).toEqual({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2" });

    const bare = {};
    applyTo(bare, true, undefined, "/hooks");
    expect(bare).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hooks", JOUZU_GIT_HOOKS_INDEX: "0" });
    applyTo(bare, false, undefined);
    expect(bare).toEqual({});
    // Off and never on: the environment is not touched.
    const untouched = { GIT_CONFIG_COUNT: "1" };
    applyTo(untouched, false, "1");
    expect(untouched).toEqual({ GIT_CONFIG_COUNT: "1" });
  });

  it("asks for the pull request line only while on, once", async () => {
    const previous = process.env.JOUZU_HOME;
    const handlers = new Map();
    extension({ on: (event, handler) => handlers.set(event, handler) });
    const run = async (on: boolean, guidelines: string[]) => {
      process.env.JOUZU_HOME = homeWith({ commitAttribution: { enabled: on } });
      await handlers.get("before_agent_start")({ systemPromptOptions: { promptGuidelines: guidelines } }, { model: { id: "m-1", name: "Model One" } });
      return guidelines;
    };
    try {
      const guidelines = await run(true, ["keep"]);
      expect(guidelines).toEqual(["keep", guideline({ name: "Model One" })]);
      expect(guidelines[1]).toContain("Generated with Jouzu Desktop (Model One)");
      expect(await run(true, guidelines)).toHaveLength(2);
      expect(await run(false, guidelines)).toEqual(["keep"]);
    } finally {
      if (previous === undefined) delete process.env.JOUZU_HOME; else process.env.JOUZU_HOME = previous;
    }
  });

  const git = spawnSync("git", ["--version"]);
  it.skipIf(git.error || git.status !== 0)("marks the agent's commits with real git and keeps the repository's hooks", () => {
    const hooks = installHooks(temp("jouzu-attr-hooks-"));
    for (const name of HOOKS) expect(spawnSync("test", ["-x", join(hooks, name)]).status ?? 0).toBe(0);
    const repo = temp("jouzu-attr-repo-");
    const base = {
      ...process.env,
      GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(repo, ".no-global"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    };
    delete base.GIT_CONFIG_PARAMETERS;
    delete base.PI_MODEL;
    delete base.PI_SESSION_ID;
    const agent = { ...base };
    applyTo(agent, true, "1", hooks);
    const run = (env, ...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    const message = () => run(base, "log", "-1", "--format=%B").stdout.trimEnd();
    const plain = "Co-authored-by: Jouzu Desktop <359074535+jouzu-desktop@users.noreply.github.com>";
    expect(run(base, "init", "-q", "-b", "main").status).toBe(0);

    expect(run(agent, "commit", "-q", "--allow-empty", "-m", "first").status).toBe(0);
    expect(message()).toBe(`first\n\n${plain}`);

    const session = { ...agent, PI_MODEL: "model-<1>", PI_SESSION_ID: "s-1" };
    expect(run(session, "commit", "-q", "--amend", "--allow-empty", "-m", "again").status).toBe(0);
    expect(message()).toBe("again\n\nCo-authored-by: Jouzu Desktop (model-1) <359074535+jouzu-desktop@users.noreply.github.com>\nJouzu-Session: s-1");
    expect(run({ ...session, PI_MODEL: "m-2" }, "commit", "-q", "--amend", "--allow-empty", "--no-edit").status).toBe(0);
    expect(message()).toBe("again\n\nCo-authored-by: Jouzu Desktop (m-2) <359074535+jouzu-desktop@users.noreply.github.com>\nJouzu-Session: s-1");

    const other = "Co-authored-by: Someone <someone@example.com>";
    expect(run(agent, "commit", "-q", "--allow-empty", "-m", `both\n\n${other}`).status).toBe(0);
    expect(message()).toBe(`both\n\n${other}\n${plain}`);

    expect(run({ ...agent, GIT_EDITOR: "true" }, "commit", "-q", "--allow-empty").status).not.toBe(0);

    // The repository's own hooks folder still runs and can still refuse.
    mkdirSync(join(repo, ".hooks"));
    writeFileSync(join(repo, ".hooks", "commit-msg"), "#!/bin/sh\ngrep -q BLOCK \"$1\" && exit 1\nexit 0\n");
    chmodSync(join(repo, ".hooks", "commit-msg"), 0o755);
    expect(run(base, "config", "core.hooksPath", ".hooks").status).toBe(0);
    expect(run(agent, "commit", "-q", "--allow-empty", "-m", "BLOCK this").status).not.toBe(0);
    expect(run(agent, "commit", "-q", "--allow-empty", "-m", "allowed").status).toBe(0);
    expect(message()).toBe(`allowed\n\n${plain}`);

    // A person's commit copied by the agent keeps its message; git without the
    // extension's configuration adds nothing.
    expect(run(base, "checkout", "-q", "-b", "side").status).toBe(0);
    expect(run(base, "commit", "-q", "--allow-empty", "-m", "by a person").status).toBe(0);
    expect(message()).toBe("by a person");
    expect(run(base, "checkout", "-q", "main").status).toBe(0);
    expect(run(agent, "cherry-pick", "--allow-empty", "side").status).toBe(0);
    expect(message()).toBe("by a person");
  // Each git call starts sh for every hook: on Windows this test takes several seconds.
  }, 60_000);
});
