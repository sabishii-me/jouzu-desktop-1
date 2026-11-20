// A stand-in for packaging/desktop/assistant/assistant.mjs in host tests:
// same protocol, no SDK, no model. Turns:
//   "[wake]..."       -> read_inbox, ack_inbox(highest seq), reply "handled N"
//   "tool <name> <json>" -> call that tool, reply with its result
//   "exit"            -> the process ends
//   anything else     -> reply "ok: <text>"
// turns.log in the working folder: each turn's text, one JSON line each.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
const pending = new Map();
let next = 0;
let turns = Promise.resolve();
const call = (name, args) => new Promise(resolve => {
  const callId = `c${++next}`;
  pending.set(callId, resolve);
  send({ type: "tool", callId, name, arguments: args });
});

async function turn({ turnId, text }) {
  appendFileSync("turns.log", `${JSON.stringify(text)}\n`);
  let reply;
  if (text.startsWith("[wake]")) {
    const inbox = await call("read_inbox", {});
    const entries = inbox.result.entries ?? [];
    const seq = Math.max(0, ...entries.map(entry => entry.seq));
    await call("ack_inbox", { seq });
    reply = `handled ${entries.length}`;
  } else if (text.startsWith("tool ")) {
    const [, name, ...rest] = text.split("\n")[0].split(" ");
    const answer = await call(name, rest.length ? JSON.parse(rest.join(" ")) : {});
    reply = JSON.stringify(answer);
  } else if (text.startsWith("exit")) {
    process.exit(3);
  } else {
    reply = `ok: ${text.split("\n")[0]}`;
  }
  send({ type: "reply", turnId, text: reply });
  send({ type: "turn_end", turnId, stopReason: "stop" });
}

lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "start") send({ type: "ready", tools: message.tools.map(tool => tool.name) });
  if (message.type === "turn") turns = turns.then(() => turn(message));
  if (message.type === "tool_result") { pending.get(message.callId)?.(message); pending.delete(message.callId); }
});
lines.on("close", () => process.exit(0));
