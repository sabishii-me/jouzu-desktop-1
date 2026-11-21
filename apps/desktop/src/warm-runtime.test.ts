import { describe, expect, it } from "vitest";
import { nextWarmView } from "./warm-runtime";

describe("warm runtime view", () => {
  it("keeps the reason of a failed warm-up", () => {
    const view = nextWarmView({ state: "starting", since: 1, error: null }, { state: "failed", error: "node missing" }, 5);
    expect(view.state).toBe("failed");
    expect(view.error).toBe("node missing");
  });

  it("times a warm-up from when the host started it, not from when the window asked", () => {
    const first = nextWarmView({ state: "unknown", since: null, error: null }, { state: "starting", elapsedMs: 4000 }, 10_000);
    expect(first.since).toBe(6000);
    const later = nextWarmView(first, { state: "starting", elapsedMs: 9000 }, 15_500);
    expect(later.since).toBe(6000);
  });
});
