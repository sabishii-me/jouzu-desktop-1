import { afterEach, beforeEach, expect, it } from "vitest";
import { lastModel, rememberModel } from "./last-model";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const models = [
  { provider: "p", id: "a", name: "Model A", thinkingLevels: [] },
  { provider: "p", id: "b", name: "Model B", thinkingLevels: [] },
];

beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage(); });
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

it("remembers nothing until the person picks a model", () => {
  expect(lastModel(models)).toBeNull();
});

it("gives back the last picked model while the catalog lists it", () => {
  rememberModel({ provider: "p", id: "a" });
  rememberModel({ provider: "p", id: "b" });
  expect(lastModel(models)?.name).toBe("Model B");
});

it("picks nothing when the last picked model is no longer listed", () => {
  rememberModel({ provider: "p", id: "gone" });
  expect(lastModel(models)).toBeNull();
});

it("works without storage", () => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  rememberModel({ provider: "p", id: "a" });
  expect(lastModel(models)).toBeNull();
});
