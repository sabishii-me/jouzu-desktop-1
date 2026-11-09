import { describe, expect, it } from "vitest";
import { loadExpanded, saveExpanded, toggleExpanded } from "./sidebar-state";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

describe("sidebar state", () => {
  it("starts with every workspace closed", () => {
    // Auto-opening a group is the bug: a fresh profile must not expand anything.
    expect(loadExpanded(memory())).toEqual(new Set());
  });

  it("remembers an opened group across remounts", () => {
    const store = memory();
    const opened = toggleExpanded(new Set(), "C:/work");
    saveExpanded(opened, store);
    expect(loadExpanded(store)).toEqual(new Set(["C:/work"]));
  });

  it("remembers a closed group", () => {
    const store = memory();
    const opened = new Set(["C:/work", "C:/other"]);
    saveExpanded(toggleExpanded(opened, "C:/work"), store);
    expect(loadExpanded(store)).toEqual(new Set(["C:/other"]));
  });

  it("ignores unreadable storage", () => {
    expect(loadExpanded(memory({ "jouzu.ui.expanded-workspaces": "{" }))).toEqual(new Set());
    expect(loadExpanded(null)).toEqual(new Set());
  });
});