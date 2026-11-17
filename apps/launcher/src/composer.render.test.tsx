import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, type ComposerProps } from "./composer";

const base: ComposerProps = {
  connected: true,
  pending: false,
  running: false,
  draft: "hello",
  onDraft: () => {},
  onSend: () => {},
  onStop: () => {},
  models: [{ provider: "p", id: "a", name: "Model A" }],
  catalogState: "ready",
  model: "Model A",
  modelState: "ready",
  onSelectModel: () => {},
  onSetupModels: () => {},
  thinkingLevels: [],
  onThinkingLevel: () => {},
};
const send = (html: string) => /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";

describe("composer model state", () => {
  it("offers Send only when the session's model is ready", () => {
    expect(send(renderToStaticMarkup(<Composer {...base} />))).not.toContain(`disabled=""`);
    expect(send(renderToStaticMarkup(<Composer {...base} modelState="none" model={undefined} />))).toContain(`disabled=""`);
    // A slash command is a message like any other: no model, no Send.
    expect(send(renderToStaticMarkup(<Composer {...base} draft="/flow clear" modelState="none" model={undefined} />))).toContain(`disabled=""`);
  });

  it("shows no model as a plain choice, not an error", () => {
    const html = renderToStaticMarkup(<Composer {...base} modelState="none" model={undefined} />);
    expect(html).toContain("Select model");
    expect(html).not.toContain("text-amber");
    expect(html).not.toContain('aria-busy="true"');
  });

  it("turns the model button into the way to set a provider up when there is no model at all", () => {
    const html = renderToStaticMarkup(<Composer {...base} models={[]} modelState="none" model={undefined} />);
    expect(html).toContain("Set up a model");
    const choose = renderToStaticMarkup(<Composer {...base} modelState="none" model={undefined} />);
    expect(choose).toContain("Select model");
    expect(choose).not.toContain("Set up a model");
  });
});
