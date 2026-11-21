// Release notes arrive as Markdown written for a changelog: paragraphs and list
// items are hard-wrapped, and a list item's continuation lines are indented
// (#206). A line break inside a block is not a break in the text, so blocks
// are rebuilt before they are shown: a blank line, a heading or a new list
// item starts a block, and every other line continues the block it is in.
export type NoteBlock = { kind: "heading" | "item" | "text"; text: string };

export function noteBlocks(value: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let open: NoteBlock | null = null;
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) { open = null; continue; }
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) { blocks.push({ kind: "heading", text: heading[1] }); open = null; continue; }
    const item = /^[-*]\s+(.*)$/u.exec(line);
    if (item) { open = { kind: "item", text: item[1] }; blocks.push(open); continue; }
    if (open) { open.text = `${open.text} ${line}`; continue; }
    open = { kind: "text", text: line };
    blocks.push(open);
  }
  return blocks;
}
