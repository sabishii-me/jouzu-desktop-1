import { describe, expect, it } from "vitest";
import { shownModel } from "./collaboration-panel";

describe("the Assistant's model in Settings", () => {
  it("shows the saved model, else the user's unsaved pick, else nothing", () => {
    const saved = { provider: "shisa", id: "glm-5.3", thinking: "high" };
    const draft = { provider: "openai-codex", id: "gpt-6-astra" };
    expect(shownModel(saved, draft)).toBe(saved);
    expect(shownModel(null, draft)).toBe(draft);
    expect(shownModel(null, null)).toBeNull();
  });
});
