import { describe, expect, it } from "vitest";
import type { AssistantRecommendation } from "./api/jouzu-api";
import { shownModel } from "./collaboration-panel";

const sol: AssistantRecommendation = { id: "gpt-6.1-sol", thinking: "low", label: "default", evidence: "", offeredBy: [{ provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] };
const astra: AssistantRecommendation = { id: "gpt-6-astra", thinking: "xhigh", label: "stronger", evidence: "", offeredBy: [] };

describe("the Assistant's model in Settings", () => {
  it("fills in the first recommended model the providers offer, with its effort", () => {
    expect(shownModel(null, null, [astra, sol])).toEqual({ provider: "openai-codex", id: "gpt-6.1-sol", thinking: "low" });
  });
  it("shows the user's choice over any recommendation", () => {
    const saved = { provider: "shisa", id: "glm-5.3", thinking: "high" };
    expect(shownModel(saved, null, [sol])).toBe(saved);
    const draft = { provider: "openai-codex", id: "gpt-6-astra" };
    expect(shownModel(null, draft, [sol])).toBe(draft);
  });
  it("fills in nothing when no recommended model is offered or the list is not in yet", () => {
    expect(shownModel(null, null, [astra])).toBeNull();
    expect(shownModel(null, null, [{ ...sol, offeredBy: null }])).toBeNull();
  });
});
