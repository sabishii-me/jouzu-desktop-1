import { describe, expect, it } from "vitest";
import {
  buildSidebar, DEFAULT_ARRANGEMENT, loadArrangement, loadManualOrder, manualFromModel,
  moveBefore, moveWithin, pathKey, saveArrangement, saveManualOrder,
  type Arrangement, type ArrangementSession,
} from "./sidebar-arrangement";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;
const session = (name: string, workspace: string, extra: Partial<ArrangementSession> = {}): ArrangementSession => ({
  path: `${workspace}/${name}.jsonl`, workspace, title: `${name} session`, updated: at(60), ...extra,
});
const workspaces = (...paths: string[]) => paths.map((path, index) => ({ id: `w${index}`, path }));
const label = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
const arrangement = (over: Partial<Arrangement> = {}): Arrangement => ({ ...DEFAULT_ARRANGEMENT, ...over });
const build = (input: Partial<Parameters<typeof buildSidebar>[0]>) => buildSidebar({
  workspaces: [], sessions: [], arrangement: arrangement(), manual: { groups: [], sessions: [] }, query: "", label, ...input,
});

describe("sidebar arrangement preferences", () => {
  it("starts with one group per workspace, newest first, archived hidden", () => {
    expect(loadArrangement(memory())).toEqual(DEFAULT_ARRANGEMENT);
  });

  it("keeps the choice the user made", () => {
    const store = memory();
    saveArrangement({ groupBy: "one-list", orderBy: "manual", filter: "archived-only" }, store);
    expect(loadArrangement(store)).toEqual({ groupBy: "one-list", orderBy: "manual", filter: "archived-only" });
  });

  it("falls back field by field when storage holds something else", () => {
    const store = memory({ "jouzu.ui.sidebar.arrangement": JSON.stringify({ groupBy: "nope", orderBy: "manual", filter: 7 }) });
    expect(loadArrangement(store)).toEqual({ ...DEFAULT_ARRANGEMENT, orderBy: "manual" });
    expect(loadArrangement(memory({ "jouzu.ui.sidebar.arrangement": "{" }))).toEqual(DEFAULT_ARRANGEMENT);
    expect(loadArrangement(null)).toEqual(DEFAULT_ARRANGEMENT);
  });

  it("keeps a manual order without duplicates", () => {
    const store = memory();
    saveManualOrder({ groups: ["c:/a", "c:/a"], sessions: ["c:/a/one.jsonl"] }, store);
    expect(loadManualOrder(store)).toEqual({ groups: ["c:/a"], sessions: ["c:/a/one.jsonl"] });
    expect(loadManualOrder(memory({ "jouzu.ui.sidebar.manual-order": "nope" }))).toEqual({ groups: [], sessions: [] });
  });
});

describe("grouping", () => {
  const demo = session("demo", "C:/Projects/demo", { updated: at(5) });
  const alpha = session("alpha", "C:/Projects/demo/packages/alpha", { updated: at(10) });
  const other = session("other", "C:/Projects/other", { updated: at(1) });

  it("shows one group per folder, newest group first", () => {
    const model = build({ workspaces: workspaces("C:/Projects/demo", "C:/Projects/other"), sessions: [demo, alpha, other] });
    expect(model.mode).toBe("groups");
    expect(model.groups.map(group => group.path)).toEqual(["C:/Projects/other", "C:/Projects/demo", "C:/Projects/demo/packages/alpha"]);
  });

  it("keeps a registered folder visible with no sessions yet", () => {
    const model = build({ workspaces: workspaces("C:/Empty"), sessions: [] });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].sessions).toEqual([]);
  });

  it("nests a workspace inside the workspace whose folder holds it", () => {
    const model = build({
      workspaces: workspaces("C:/Projects/demo", "C:/Projects/demo/packages", "C:/Projects/demo/packages/alpha", "C:/Projects/other"),
      sessions: [demo, alpha, other],
      arrangement: arrangement({ groupBy: "tree" }),
    });
    expect(model.groups.map(group => [label(group.path), group.depth])).toEqual([["other", 0], ["demo", 0], ["packages", 1], ["alpha", 2]]);
  });

  it("does not treat a shared prefix as a parent folder", () => {
    const model = build({
      workspaces: workspaces("C:/Projects/demo", "C:/Projects/demo-two"),
      arrangement: arrangement({ groupBy: "tree" }),
    });
    expect(model.groups.map(group => group.depth)).toEqual([0, 0]);
  });

  it("puts every session in one list, newest first", () => {
    const model = build({ sessions: [demo, alpha, other], arrangement: arrangement({ groupBy: "one-list" }) });
    expect(model.mode).toBe("list");
    expect(model.groups).toEqual([]);
    expect(model.sessions.map(item => item.title)).toEqual(["other session", "demo session", "alpha session"]);
  });
});

describe("order", () => {
  it("follows the user's order and keeps new sessions at the end", () => {
    const older = session("older", "C:/a", { updated: at(30) });
    const newer = session("newer", "C:/a", { updated: at(1) });
    const fresh = session("fresh", "C:/a", { updated: at(0) });
    const model = build({
      sessions: [older, newer, fresh],
      arrangement: arrangement({ orderBy: "manual" }),
      manual: { groups: [], sessions: [pathKey(newer.path), pathKey(older.path)] },
    });
    expect(model.groups[0].sessions.map(item => item.title)).toEqual(["newer session", "older session", "fresh session"]);
  });

  it("orders groups by the user's order too", () => {
    const model = build({
      workspaces: workspaces("C:/a", "C:/b"),
      arrangement: arrangement({ orderBy: "manual" }),
      manual: { groups: ["c:/b", "c:/a"], sessions: [] },
    });
    expect(model.groups.map(group => group.path)).toEqual(["C:/b", "C:/a"]);
  });

  it("moves one entry within the list on screen", () => {
    expect(moveWithin(["a", "b", "c"], "b", -1, ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    expect(moveWithin(["a", "b", "c"], "b", 1, ["a", "b", "c"])).toEqual(["a", "c", "b"]);
    expect(moveWithin(["a", "b", "c"], "a", -1, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(moveWithin(["a", "b", "c"], "c", 1, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("moves a session the user's order does not know yet", () => {
    expect(moveWithin(["a", "b"], "c", -1, ["a", "b", "c"])).toEqual(["a", "c", "b"]);
  });

  it("drops one entry before another", () => {
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
  });

  it("seeds the manual order from what is on screen", () => {
    const model = build({ sessions: [session("one", "C:/a"), session("two", "C:/b")] });
    expect(manualFromModel(model)).toEqual({
      groups: model.groups.map(group => group.id),
      sessions: model.groups.flatMap(group => group.sessions.map(item => pathKey(item.path))),
    });
  });
});

describe("filter and search", () => {
  const live = session("live", "C:/a", { updated: at(2) });
  const archived = session("archived", "C:/a", { archived: true, updated: at(3) });

  it("hides archived sessions by default and can show only them", () => {
    expect(build({ sessions: [live, archived] }).groups[0].sessions.map(item => item.title)).toEqual(["live session"]);
    expect(build({ sessions: [live, archived], arrangement: arrangement({ filter: "all" }) }).groups[0].sessions.map(item => item.title)).toEqual(["live session", "archived session"]);
    expect(build({ sessions: [live, archived], arrangement: arrangement({ filter: "archived-only" }) }).groups[0].sessions.map(item => item.title)).toEqual(["archived session"]);
  });

  it("keeps a whole group whose name matches, and only matching sessions otherwise", () => {
    const one = session("one", "C:/alpha", { updated: at(1) });
    const two = session("two", "C:/alpha", { updated: at(2) });
    const byGroup = build({ sessions: [one, two], query: "alpha" });
    expect(byGroup.groups.map(group => group.sessions.length)).toEqual([2]);
    const bySession = build({ sessions: [one, two], query: "two" });
    expect(bySession.groups.map(group => group.sessions.map(item => item.title))).toEqual([["two session"]]);
    expect(build({ sessions: [one], query: "missing" }).groups).toEqual([]);
  });

  it("searches one list by session title and by workspace name", () => {
    const one = session("one", "C:/alpha", { updated: at(1) });
    const two = session("two", "C:/beta", { updated: at(2) });
    const model = build({ sessions: [one, two], query: "beta", arrangement: arrangement({ groupBy: "one-list" }) });
    expect(model.sessions.map(item => item.title)).toEqual(["two session"]);
  });
});
