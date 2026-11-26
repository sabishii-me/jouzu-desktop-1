import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ApiProvider } from "./api/context";
import type { JouzuApi } from "./api/jouzu-api";
import { setAppViewForTest, type AppView, type ImageProvider, type ToolsView } from "./app-view";
import { imageCardState, ToolsPanel } from "./tools-panel";

const settings = { image: { enabled: true, provider: "", model: "", size: "1K", maxImages: 3 }, reviewTools: ["generate_image"] };
const shisa: ImageProvider = { id: "shisa", label: "Shisa.AI", usable: true, models: [{ id: "gemini-3.1-flash-image", sizes: ["1K", "2K"] }] };
const notInPlan: ImageProvider = { id: "shisa", label: "Shisa.AI", usable: false, code: "not-allowed", reason: "This account's plan does not include image generation.", models: [] };
const chatgpt: ImageProvider = { id: "openai-codex", label: "ChatGPT", usable: true, models: [{ id: "gpt-image-2", sizes: ["1K"] }] };

function tools(providers: ImageProvider[] | null, state: ToolsView["state"] = "ready", image = settings.image): ToolsView {
  const first = providers?.find(provider => provider.usable);
  return {
    settings: { ...settings, image },
    state,
    report: providers && { usable: !!first, defaults: { provider: first?.id ?? "", model: first?.models[0]?.id ?? "", size: "1K", maxImages: 3 }, providers },
  };
}

function render(view: ToolsView) {
  setAppViewForTest({ revision: 1, config: { running: null, queued: [], lastResult: {} }, settings: null, tools: view } as AppView);
  return renderToStaticMarkup(<ApiProvider api={{} as JouzuApi}><ToolsPanel onOpenProviders={() => {}} /></ApiProvider>);
}

afterEach(() => setAppViewForTest(null));

describe("the image generation card", () => {
  it("shows only Checking until the report for this configuration arrived", () => {
    const markup = render(tools([shisa], "checking"));
    expect(markup).toContain('data-image-state="checking"');
    expect(markup).toContain("Checking image providers");
    expect(markup).not.toContain("Image provider<");
  });

  it("with no provider added: the switch is off and cannot turn on, and Model providers is offered", () => {
    const markup = render(tools([]));
    expect(markup).toContain('data-image-state="none-added"');
    expect(markup).toMatch(/aria-checked="false"[^>]*disabled|disabled[^>]*aria-checked="false"/u);
    expect(markup).toContain("Open Model providers");
    // No list of providers nobody added.
    expect(markup).not.toContain("OpenRouter");
  });

  it("with providers added that cannot make images: each reason, Check again, and the switch off", () => {
    const markup = render(tools([notInPlan], "ready", { ...settings.image, enabled: true }));
    expect(markup).toContain('data-image-state="none-usable"');
    expect(markup).toContain("Shisa.AI: This account&#x27;s plan does not include image generation.");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain('aria-checked="true"');
  });

  it("with a usable provider: the switch, then provider, model, size and images per call", () => {
    const markup = render(tools([shisa, chatgpt]));
    expect(markup).toContain('data-image-state="usable"');
    expect(markup).toContain('aria-checked="true"');
    for (const label of ["Image provider", "Image model", "Image size", "Images per call"]) expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain("gemini-3.1-flash-image");
  });

  it("shows no size for a model without a size choice", () => {
    const markup = render(tools([{ ...chatgpt, models: [{ id: "flux", sizes: [] }] }]));
    expect(markup).not.toContain('aria-label="Image size"');
  });

  it("keeps a chosen provider that cannot make images in place, with its reason, beside usable ones", () => {
    const markup = render(tools([notInPlan, chatgpt], "ready", { ...settings.image, provider: "shisa" }));
    expect(markup).toContain('data-image-state="usable"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Open Model providers");
  });

  it("with a saved provider that was removed: shows the provider in effect with its model, as the image tool uses it", () => {
    const markup = render(tools([shisa], "ready", { ...settings.image, provider: "openai-codex", model: "gpt-image-2" }));
    expect(markup).toContain('data-image-state="usable"');
    expect(markup).toMatch(/<option value="shisa" selected="">Shisa.AI<\/option>/u);
    expect(markup).toContain('aria-label="Image model"');
    expect(markup).toMatch(/<option value="gemini-3.1-flash-image" selected="">/u);
    expect(markup).not.toContain('role="alert"');
  });

  it("shows the model's first size when it does not make the saved one", () => {
    const markup = render(tools([shisa], "ready", { ...settings.image, provider: "shisa", size: "4K" }));
    expect(markup).toMatch(/<option value="1K" selected="">/u);
  });

  it("is decided by the report alone", () => {
    expect(imageCardState(undefined)).toBe("checking");
    expect(imageCardState(tools(null))).toBe("checking");
    expect(imageCardState(tools([]))).toBe("none-added");
    expect(imageCardState(tools([notInPlan]))).toBe("none-usable");
    expect(imageCardState(tools([notInPlan, chatgpt]))).toBe("usable");
  });
});
