// Fake pi RPC runtime for host tests. It speaks the real wire shapes:
// {id,type:"response",...} and agent/message/tool events.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const delay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 15);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, command, data) =>
  out({ id, type: "response", command, success: true, data });
const failure = (id, command, error) =>
  out({ id, type: "response", command, success: false, error });

let busy = false;
let interrupted = false;
let timer = null;
let current = null;

if (process.env.FAKE_RUNTIME_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_RUNTIME_CHILD_PID_FILE, String(child.pid));
}

function settled(aborted) {
  busy = false;
  clearTimeout(timer);
  current = null;
  out({ type: "agent_settled", aborted });
}

function tick() {
  if (!busy || !current) return;
  if (interrupted) {
    settled(true);
    return;
  }
  const { parts, index } = current;
  if (index < parts.length) {
    out({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: parts[index],
      },
    });
    current.index += 1;
    timer = setTimeout(tick, delay);
    return;
  }
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: parts.join("") }] },
  });
  settled(false);
}

function prompt(id, text) {
  busy = true;
  interrupted = false;
  current = { id, parts: Array.from(text), index: 0 };
  response(id, "prompt", { disposition: "handled" });
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  tick();
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  switch (value.type) {
    case "get_messages":
      response(value.id, "get_messages", { messages: [] });
      break;
    case "switch_session":
      response(value.id, "switch_session", { cancelled: false });
      break;
    case "prompt":
      if (busy) {
        failure(value.id, "prompt", "prompt while busy");
        break;
      }
      prompt(value.id, String(value.message ?? ""));
      break;
    case "abort":
      response(value.id, "abort", {});
      if (busy) {
        interrupted = true;
        if (current) clearTimeout(timer);
        settled(true);
      }
      break;
    default:
      failure(value.id, String(value.type ?? "unknown"), "unsupported command");
      break;
  }
});
lines.on("close", () => process.exit(0));
