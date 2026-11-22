import { describe, expect, it } from "vitest";
import { composerRunningFor } from "./composer-state";

describe("composer turn phase mapping", () => {
  const turn = (phase: string) => ({ turnId: "turn-1", phase });

  it("keeps a starting active turn in the non-steering composer state", () => {
    expect(composerRunningFor(turn("starting"), true)).toBe(false);
  });

  it("allows steering once the host reports a running turn", () => {
    expect(composerRunningFor(turn("running"), true)).toBe(true);
  });

  it("uses the projection fallback when no active turn exists", () => {
    expect(composerRunningFor(undefined, false)).toBe(false);
    expect(composerRunningFor(undefined, true)).toBe(true);
  });
});
