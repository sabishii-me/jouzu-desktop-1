/**
 * The views the Assistant draws (`jouzu-view` blocks), as its skill
 * `draw-task-views.md` teaches them; that skill is the format's one source.
 * This module only reads a block and lays it out; it holds no state. A view
 * names tasks by id, and their titles and states are looked up when it is
 * drawn, so a view is never out of date.
 */

export type TaskRef = string;

export type TaskView =
  | { view: "board"; title?: string; columns: Array<{ title: string; taskIds: TaskRef[] }> }
  | { view: "table"; title?: string; columns: string[]; rows: Array<{ taskId?: TaskRef; cells: string[] }> }
  | { view: "graph"; title?: string; nodes: Array<{ id: string; label: string; taskId?: TaskRef }>; edges: Array<{ from: string; to: string }> }
  | { view: "timeline"; title?: string; items: Array<{ at: string; label: string; taskId?: TaskRef }> }
  | { view: "progress"; title?: string; taskIds: TaskRef[] };

/** Why a block could not be read, for the person: which part is wrong. */
export type ViewProblem =
  | { kind: "json"; detail: string }
  | { kind: "unknown"; view: string }
  | { kind: "field"; field: string };

export type Parsed = { ok: true; view: TaskView } | { ok: false; problem: ViewProblem };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown) => value === undefined || isString(value);

class FieldError extends Error {
  constructor(readonly field: string) { super(field); }
}

function list<T>(value: unknown, field: string, item: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new FieldError(field);
  return value.map((entry, index) => item(entry, `${field}[${index}]`));
}

function text(value: unknown, field: string): string {
  if (!isString(value)) throw new FieldError(field);
  return value;
}

function taskId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field);
}

function title(source: Record<string, unknown>): string | undefined {
  if (!optionalString(source.title)) throw new FieldError("title");
  return source.title as string | undefined;
}

/** Reads one `jouzu-view` block. Never throws: a block that cannot be read says why. */
export function parseView(source: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { ok: false, problem: { kind: "json", detail: error instanceof Error ? error.message : String(error) } };
  }
  if (!isObject(data)) return { ok: false, problem: { kind: "field", field: "view" } };
  try {
    switch (data.view) {
      case "board":
        return { ok: true, view: { view: "board", title: title(data), columns: list(data.columns, "columns", (column, path) => {
          if (!isObject(column)) throw new FieldError(path);
          return { title: text(column.title, `${path}.title`), taskIds: list(column.taskIds, `${path}.taskIds`, text) };
        }) } };
      case "table": {
        const columns = list(data.columns, "columns", text);
        return { ok: true, view: { view: "table", title: title(data), columns, rows: list(data.rows, "rows", (row, path) => {
          if (!isObject(row)) throw new FieldError(path);
          return { taskId: taskId(row.taskId, `${path}.taskId`), cells: list(row.cells, `${path}.cells`, (cell, cellPath) => isString(cell) || typeof cell === "number" ? String(cell) : text(cell, cellPath)) };
        }) } };
      }
      case "graph": {
        const nodes = list(data.nodes, "nodes", (node, path) => {
          if (!isObject(node)) throw new FieldError(path);
          return { id: text(node.id, `${path}.id`), label: text(node.label, `${path}.label`), taskId: taskId(node.taskId, `${path}.taskId`) };
        });
        const ids = new Set(nodes.map(node => node.id));
        const edges = list(data.edges ?? [], "edges", (edge, path) => {
          if (!isObject(edge)) throw new FieldError(path);
          const from = text(edge.from, `${path}.from`);
          const to = text(edge.to, `${path}.to`);
          if (!ids.has(from)) throw new FieldError(`${path}.from`);
          if (!ids.has(to)) throw new FieldError(`${path}.to`);
          return { from, to };
        });
        return { ok: true, view: { view: "graph", title: title(data), nodes, edges } };
      }
      case "timeline":
        return { ok: true, view: { view: "timeline", title: title(data), items: list(data.items, "items", (item, path) => {
          if (!isObject(item)) throw new FieldError(path);
          return { at: text(item.at, `${path}.at`), label: text(item.label, `${path}.label`), taskId: taskId(item.taskId, `${path}.taskId`) };
        }) } };
      case "progress":
        return { ok: true, view: { view: "progress", title: title(data), taskIds: list(data.taskIds, "taskIds", text) } };
      default:
        return isString(data.view)
          ? { ok: false, problem: { kind: "unknown", view: data.view } }
          : { ok: false, problem: { kind: "field", field: "view" } };
    }
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, problem: { kind: "field", field: error.field } };
    throw error;
  }
}

/** A task's state as the host derives it (`tasks.rs`). */
export type TaskState = "waiting_to_start" | "starting" | "running" | "waiting_user" | "held" | "finished" | "failed" | "stopped" | "unloaded";

/** How the progress view groups states: finished, failed or stopped, waiting on the person, under way. */
export type ProgressGroup = "done" | "ended" | "needsYou" | "underWay" | "unknown";

export function progressGroup(state: string | undefined): ProgressGroup {
  switch (state) {
    case "finished": return "done";
    case "failed": case "stopped": return "ended";
    case "waiting_user": case "held": return "needsYou";
    case "waiting_to_start": case "starting": case "running": return "underWay";
    default: return "unknown";
  }
}

/** Counts per group, in the order the bar draws them. */
export function progressCounts(states: Array<string | undefined>): Record<ProgressGroup, number> {
  const counts: Record<ProgressGroup, number> = { done: 0, ended: 0, needsYou: 0, underWay: 0, unknown: 0 };
  for (const state of states) counts[progressGroup(state)] += 1;
  return counts;
}

/**
 * Where each node of a dependency graph goes: its layer is the longest chain of
 * dependencies before it (so every edge points to a later layer), and its row
 * is its place within that layer. A cycle cannot be layered; its nodes stay in
 * the layer they had reached and the edge back is drawn as it is.
 */
export function layoutGraph(nodes: Array<{ id: string }>, edges: Array<{ from: string; to: string }>): Map<string, { layer: number; row: number }> {
  const layer = new Map(nodes.map(node => [node.id, 0]));
  // At most one pass per node: longer chains cannot exist without a cycle.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const edge of edges) {
      const next = (layer.get(edge.from) ?? 0) + 1;
      if (next > (layer.get(edge.to) ?? 0) && next < nodes.length) {
        layer.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rows = new Map<number, number>();
  const placed = new Map<string, { layer: number; row: number }>();
  for (const node of nodes) {
    const at = layer.get(node.id) ?? 0;
    const row = rows.get(at) ?? 0;
    rows.set(at, row + 1);
    placed.set(node.id, { layer: at, row });
  }
  return placed;
}

/** Timeline items in date order; items with the same date keep their order. */
export function timelineOrder<T extends { at: string }>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
    .map(entry => entry.item);
}

/**
 * How a timeline item's `at` reads: a date or a date and time in the
 * person's own format; anything else (a week, "Q1") as written.
 */
export function timelineWhen(at: string, locale?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(at)) {
    const day = new Date(`${at}T00:00:00Z`);
    if (!Number.isNaN(day.getTime())) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(day);
  }
  if (/^\d{4}-\d{2}-\d{2}T/u.test(at)) {
    const moment = new Date(at);
    if (!Number.isNaN(moment.getTime())) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(moment);
  }
  return at;
}
