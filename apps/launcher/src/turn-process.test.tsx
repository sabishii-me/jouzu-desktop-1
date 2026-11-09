import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTurnDuration, TurnProcess } from "./turn-process";

describe("turn process row", () => {
  it("formats the settled duration", () => {
    expect(formatTurnDuration(undefined)).toBeUndefined();
    expect(formatTurnDuration(900)).toBeUndefined();
    expect(formatTurnDuration(12_000)).toBe("12s");
    expect(formatTurnDuration(63_000)).toBe("1m 3s");
    expect(formatTurnDuration(3_720_000)).toBe("1h 2m");
  });

  it("starts collapsed and carries the outcome in the label", () => {
    const html = renderToStaticMarkup(<TurnProcess outcome="failed" activity={[]} summary={{ artifacts: [], files: [] }} />);
    expect(html).toContain("Failed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Turn process"');
  });

  it("does not render work details until it is opened", () => {
    const html = renderToStaticMarkup(<TurnProcess outcome="complete" durationMs={63_000} activity={[]} summary={{ artifacts: [], files: ["C:/work/a.md"] }} />);
    expect(html).toContain("Completed in 1m 3s");
    expect(html).not.toContain("a.md");
  });
});
