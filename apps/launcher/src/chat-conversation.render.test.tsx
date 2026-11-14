import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatConversation } from "./chat-conversation";
import { emptyProjection, type ChatProjection } from "./chat-projection";

const running = (last: "thinking" | "toolCall"): ChatProjection => ({
  ...emptyProjection(),
  running: true,
  activeMessage: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first step" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        ...(last === "thinking" ? [{ type: "thinking", thinking: "now writing" }] : [{ type: "thinking", thinking: "second step" }, { type: "toolCall", id: "t2", name: "bash", arguments: {} }]),
      ],
    },
  ],
  tools: { t1: { id: "t1", name: "bash", args: {}, phase: "complete" } },
});
const reasoning = (html: string) => (html.match(/aria-label="Thinking · done"/g) ?? []).length;

describe("a long turn", () => {
  it("keeps each finished step's reasoning while the turn runs", () => {
    expect(reasoning(renderToStaticMarkup(<ChatConversation projection={running("toolCall")} />))).toBe(2);
  });

  it("leaves only the reasoning being written to the status line", () => {
    expect(reasoning(renderToStaticMarkup(<ChatConversation projection={running("thinking")} />))).toBe(1);
  });
});
