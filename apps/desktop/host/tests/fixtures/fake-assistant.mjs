// A stand-in for the jouzu runtime the Assistant runs on, in host tests. It
// speaks the pi RPC wire (get_state, set_model, set_thinking_level, prompt,
// abort) and loads the extension it is given with --extension (the real
// jouzu-assistant), the way the runtime would, through a minimal `pi`; tool
// calls go through that extension to the host's bridge. No model. Turns:
//   "[wake]..."          -> read_inbox, ack_inbox(highest seq), say "handled N"
//   "tool <name> <json>" -> call that tool, reply with its result
//   "fail <text>"        -> the model call fails with that text
//   "exit"               -> the process ends
//   "slow <text>"        -> say "working", wait for abort, then say <text>
//   anything else        -> say "ok: <text>"
// Each say goes through the say tool; the turn's final plain text is not a reply.
// A user message's "[user message mN]" first line is read past, as a model would.
// In its working folder: turns.log (each turn's text, one JSON line each) and
// args.json (the arguments and Assistant variables it started with).
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const value = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
writeFileSync("args.json", JSON.stringify({
  argv,
  flow: process.env.JOUZU_FLOW_CONTROL ?? null,
  home: process.env.JOUZU_HOME ?? null,
  token: Boolean(process.env.JOUZU_ASSISTANT_TOKEN),
}));
const tools = new Map();
const extension = value("--extension");
if (extension) {
  const module = await import(pathToFileURL(join(extension, "index.js")).href);
  module.default({ registerTool: tool => tools.set(tool.name, tool), on: () => {} });
}
const allowed = new Set((value("--tools") ?? "").split(",").filter(Boolean));

const out = record => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, command, data) => out({ id, type: "response", command, success: true, data });
const refuse = (id, command, error) => out({ id, type: "response", command, success: false, error });
let model = null;
let aborted = () => {};
let turns = Promise.resolve();

async function call(name, args) {
  const tool = tools.get(name);
  if (!tool || !allowed.has(name)) return { error: `Tool ${name} not found` };
  const result = await tool.execute("call", args, undefined);
  return { ok: result.isError !== true, result: JSON.parse(result.content[0].text) };
}

function message(text, extra = {}) {
  const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra };
  out({ type: "message_start", message });
  out({ type: "message_end", message });
}

// Speaks through the say tool, as the Assistant must, then ends the turn with
// the same words as plain text, which the host must not show.
async function say(text) {
  await call("say", { text });
  message(`(final text) ${text}`);
}

async function turn(raw) {
  appendFileSync("turns.log", `${JSON.stringify(raw)}\n`);
  out({ type: "agent_start" });
  const header = /^\[user message (m\d+)\]\n/u.exec(raw);
  const text = header ? raw.slice(header[0].length) : raw;
  if (text.startsWith("[wake]")) {
    const inbox = await call("read_inbox", {});
    const entries = inbox.result?.entries ?? [];
    const seq = Math.max(0, ...entries.map(entry => entry.seq));
    await call("ack_inbox", { seq });
    await say(`handled ${entries.length}`);
  } else if (text.startsWith("tool ")) {
    const [, name, ...rest] = text.split("\n")[0].split(" ");
    await say(JSON.stringify(await call(name, rest.length ? JSON.parse(rest.join(" ")) : {})));
  } else if (text.startsWith("fail ")) {
    message("", { stopReason: "error", errorMessage: text.slice(5).split("\n")[0] });
  } else if (text.startsWith("slow ")) {
    await call("say", { text: "working" });
    await new Promise(resolve => { aborted = resolve; });
    const result = await call("say", { text: text.slice(5).split("\n")[0] });
    appendFileSync("said.log", `${JSON.stringify(result.result)}\n`);
    out({ type: "agent_settled", aborted: true });
    return;
  } else if (text.startsWith("exit")) {
    process.stderr.write("fake runtime: asked to exit\n");
    process.exit(3);
  } else {
    await say(`ok: ${text.split("\n")[0]}`);
  }
  out({ type: "agent_settled", aborted: false });
}

createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  switch (command.type) {
    case "get_state": respond(command.id, "get_state", { sessionId: value("--session-id"), isStreaming: false, model }); break;
    case "set_model":
      if (command.modelId === "missing") { refuse(command.id, "set_model", "Model not found: missing"); break; }
      model = { provider: command.provider, id: command.modelId };
      respond(command.id, "set_model", model);
      break;
    case "set_thinking_level": respond(command.id, "set_thinking_level"); break;
    case "prompt":
      respond(command.id, "prompt");
      turns = turns.then(() => turn(String(command.message ?? "")));
      break;
    case "abort": respond(command.id, "abort"); aborted(); break;
    default: refuse(command.id, String(command.type), "unsupported command");
  }
}).on("close", () => process.exit(0));
