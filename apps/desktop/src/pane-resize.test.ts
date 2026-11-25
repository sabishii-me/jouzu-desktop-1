import { describe, expect, it } from "vitest";
import { PANE_MAX_WIDTH, PANE_MIN_WIDTH, resizedPaneWidth } from "./pane-resize";

describe("pane resize", () => {
  it("widens the right-docked panel when the handle is dragged left", () => {
    expect(resizedPaneWidth(720, 1000, 900)).toBe(820);
  });

  it("narrows the right-docked panel when the handle is dragged right", () => {
    expect(resizedPaneWidth(720, 1000, 1060)).toBe(660);
  });

  it("keeps the width unchanged when the pointer does not move", () => {
    expect(resizedPaneWidth(720, 1000, 1000)).toBe(720);
  });

  it("clamps to the minimum so the panel stays usable", () => {
    expect(resizedPaneWidth(720, 1000, 5000)).toBe(PANE_MIN_WIDTH);
  });

  it("clamps to the maximum so the conversation stays usable", () => {
    expect(resizedPaneWidth(720, 1000, -5000)).toBe(PANE_MAX_WIDTH);
  });

  it("does not get stuck at a bound once the pointer comes back", () => {
    // A drag that passes the min clamps there, but moving back toward startX
    // within the same drag grows the width again from the recorded start.
    expect(resizedPaneWidth(720, 1000, 9000)).toBe(PANE_MIN_WIDTH);
    expect(resizedPaneWidth(720, 1000, 900)).toBe(820);
    expect(resizedPaneWidth(720, 1000, -9000)).toBe(PANE_MAX_WIDTH);
    expect(resizedPaneWidth(720, 1000, 1100)).toBe(620);
  });
});
