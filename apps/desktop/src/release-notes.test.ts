import { describe, expect, it } from "vitest";
import { noteBlocks } from "./release-notes";

describe("noteBlocks", () => {
  // #206: the 1.1.4 notes as the changelog wraps them.
  it("joins wrapped paragraph lines and indented item continuations", () => {
    const notes = [
      "Stable release. It follows 1.0.23 on the stable channel and contains everything from 1.1.0",
      "to 1.1.4-rc.1 (the QA channel's release candidates).",
      "",
      "- Chats keep running on their own. Closing or reloading the window no longer stops a reply,",
      "  and a window that reconnects catches up.",
      "- A new session can send at once.",
    ].join("\n");
    expect(noteBlocks(notes)).toEqual([
      { kind: "text", text: "Stable release. It follows 1.0.23 on the stable channel and contains everything from 1.1.0 to 1.1.4-rc.1 (the QA channel's release candidates)." },
      { kind: "item", text: "Chats keep running on their own. Closing or reloading the window no longer stops a reply, and a window that reconnects catches up." },
      { kind: "item", text: "A new session can send at once." },
    ]);
  });

  it("keeps headings and separate paragraphs apart, and reads Windows line ends", () => {
    expect(noteBlocks("### Fixed\r\n- One\r\n\r\nFirst\r\n\r\nSecond")).toEqual([
      { kind: "heading", text: "Fixed" },
      { kind: "item", text: "One" },
      { kind: "text", text: "First" },
      { kind: "text", text: "Second" },
    ]);
  });

  it("shows notes already written one block per line unchanged", () => {
    expect(noteBlocks("Intro\n- A\n- B")).toEqual([
      { kind: "text", text: "Intro" },
      { kind: "item", text: "A" },
      { kind: "item", text: "B" },
    ]);
  });
});
