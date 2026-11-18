// Loaded into every Node process the test host starts (through NODE_OPTIONS), it holds
// a Jouzu runtime's start for as long as the abnormal-path exam asks: a runtime that is
// slow to start, as on a busy or slow computer. Test-only; it changes nothing else.
// The delay is read from the file JOUZU_E2E_RUNTIME_DELAY names: {"ms": n}.
import { readFileSync } from 'node:fs';

const file = process.env.JOUZU_E2E_RUNTIME_DELAY;
// Only a runtime in RPC mode, never the configuration service or another helper.
if (file && process.argv.includes('rpc')) {
  let ms = 0;
  try { ms = Number(JSON.parse(readFileSync(file, 'utf8')).ms) || 0; } catch { /* no delay */ }
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
