import { describe, expect, it } from "vitest";
import skill from "../../../packaging/desktop/assistant/skills/draw-task-views.md?raw";
import { layoutGraph, parseView, progressCounts, timelineOrder } from "./task-views-model";

// The Assistant is taught the format by its skill; every example there must read.
const examples = [...skill.matchAll(/^\s+(\{"view":.*\})\s*$/gmu)].map(match => match[1]);

describe("the Assistant's views", () => {
  it("reads every example its skill teaches", () => {
    expect(examples.map(example => JSON.parse(example).view).sort()).toEqual(["board", "graph", "progress", "table", "timeline"]);
    for (const example of examples) expect(parseView(example), example).toMatchObject({ ok: true });
  });

  it("says which part of a block is wrong instead of showing it as code", () => {
    expect(parseView("{\"view\":\"board\",")).toMatchObject({ ok: false, problem: { kind: "json" } });
    expect(parseView(JSON.stringify({ view: "kanban" }))).toEqual({ ok: false, problem: { kind: "unknown", view: "kanban" } });
    expect(parseView(JSON.stringify({ view: "board", columns: [{ title: "Now" }] }))).toEqual({ ok: false, problem: { kind: "field", field: "columns[0].taskIds" } });
    expect(parseView(JSON.stringify({ view: "graph", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "b" }] }))).toEqual({ ok: false, problem: { kind: "field", field: "edges[0].to" } });
    expect(parseView("[]")).toEqual({ ok: false, problem: { kind: "field", field: "view" } });
  });

  it("lays a graph out so every dependency points forward", () => {
    const nodes = [{ id: "test" }, { id: "design" }, { id: "code" }, { id: "docs" }];
    const edges = [{ from: "design", to: "code" }, { from: "code", to: "test" }, { from: "design", to: "docs" }];
    const placed = layoutGraph(nodes, edges);
    for (const edge of edges) expect(placed.get(edge.to)!.layer).toBeGreaterThan(placed.get(edge.from)!.layer);
    expect(placed.get("code")).toEqual({ layer: 1, row: 0 });
    expect(placed.get("docs")).toEqual({ layer: 1, row: 1 });
  });

  it("still lays out a graph with a cycle", () => {
    const placed = layoutGraph([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
    expect(placed.size).toBe(2);
    expect([...placed.values()].every(spot => spot.layer < 2)).toBe(true);
  });

  it("counts progress from the tasks' live states", () => {
    expect(progressCounts(["finished", "finished", "failed", "waiting_user", "running", undefined])).toEqual({ done: 2, ended: 1, needsYou: 1, underWay: 1, unknown: 1 });
  });

  it("orders a timeline by date, keeping the order of the same date", () => {
    expect(timelineOrder([{ at: "2026-11-24", label: "b" }, { at: "2026-11-21", label: "a" }, { at: "2026-11-24", label: "c" }]).map(item => item.label)).toEqual(["a", "b", "c"]);
  });
});
