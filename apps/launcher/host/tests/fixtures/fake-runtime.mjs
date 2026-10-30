// Minimal runtime used by the host tests. It speaks only the JSONL subset the
// host session manager needs: ready, delta, done, error and interrupt.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const delay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 15);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);

let busy = false;
let interrupted = false;
let timer = null;

if (process.env.FAKE_RUNTIME_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_RUNTIME_CHILD_PID_FILE, String(child.pid));
}

function finish(id, stopReason) {
  busy = false;
  clearTimeout(timer);
  out({ type: "done", id, stopReason });
}

function run(id, text) {
  busy = true;
  interrupted = false;
  const parts = Array.from(text);
  let index = 0;
  const tick = () => {
    if (!busy) return;
    if (interrupted) {
      finish(id, "interrupted");
      return;
    }
    if (index < parts.length) {
      out({ type: "delta", id, text: parts[index] });
      index += 1;
      timer = setTimeout(tick, delay);
      return;
    }
    finish(id, "completed");
  };
  tick();
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    out({ type: "error", message: "invalid JSON" });
    return;
  }
  if (value.type === "prompt") {
    if (busy) {
      out({ type: "error", message: "prompt while busy" });
      return;
    }
    run(value.id, value.text);
  } else if (value.type === "interrupt") {
    interrupted = true;
  }
});
lines.on("close", () => process.exit(0));

out({ type: "ready" });
