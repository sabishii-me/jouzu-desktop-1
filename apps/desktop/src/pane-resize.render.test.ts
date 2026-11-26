import workspaceSource from "./chat-workspace.tsx?raw";
import { describe, expect, it } from "vitest";

// #186: the e2e spec exercises the actual drag and width change. This test pins
// the non-visual affordances around it (role, pointer capture, cancel hooks and
// the hit-area classes) so a refactor cannot silently remove them.
describe("the panel divider is a usable drag handle (#186)", () => {
  const separator = workspaceSource.match(/role="separator"[\s\S]*?<\/div>/)?.[0] ?? "";

  it("has a separator with a resize role and an accessible label", () => {
    expect(separator).toContain('role="separator"');
    expect(separator).toContain("aria-label={t.resizePane}");
  });

  it("wires pointer capture so the drag survives leaving the narrow handle", () => {
    expect(separator).toContain("setPointerCapture(event.pointerId)");
  });

  it("disables touch scrolling and text selection on the handle", () => {
    expect(separator).toContain("touch-none");
    expect(separator).toContain("select-none");
  });

  it("uses a hit area wider than the visible border it sits on", () => {
    // -left-1 + w-2 straddles the pane's 1px border with an 8px grab area.
    expect(separator).toContain("-left-1");
    expect(separator).toContain("w-2");
    expect(separator).toContain("hover:bg-primary/20");
  });

  it("ends the drag on release, cancellation and lost capture", () => {
    expect(workspaceSource).toContain('window.addEventListener("pointerup", stop)');
    expect(workspaceSource).toContain('window.addEventListener("pointercancel", stop)');
    expect(workspaceSource).toContain('window.addEventListener("lostpointercapture", stop)');
  });
});
