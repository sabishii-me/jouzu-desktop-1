// Stand-in for abnormal-exam.mjs in the runner's self-test: behaves per case name.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const name = process.env.ABN_ONLY, language = process.env.ABN_LANGS, out = process.env.ABN_OUT;
mkdirSync(out, { recursive: true });
const write = record => writeFileSync(join(out, 'abnormal-exam.json'), JSON.stringify({ runs: [{ language, result: { errors: [], cases: [{ name, notes: [], problems: [], metrics: {}, ms: 10, ...record }] } }] }));
if (name === 'Passes') write({ ok: true });
if (name === 'Fails') write({ ok: false, problems: ['the reply never came'] });
if (name === 'Hangs') { spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', join(process.env.TMPDIR ?? process.env.TEMP, 'child')], { stdio: 'ignore' }); setInterval(() => {}, 1000); }
if (name === 'Crashes the exam') throw new Error('exam crashed');
if (name === 'Skips with a planned reason' || name === 'Skips without a planned reason') write({ ok: true, skipped: true, notes: ['not on this machine'] });
if (name === 'Flaky') { const mark = join(out, '..', 'flaky-count'); const n = existsSync(mark) ? 1 : 0; writeFileSync(mark, 'x'); write(n ? { ok: true } : { ok: false, problems: ['failed once'] }); }
if (name === 'Leaves a process behind') { spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)', join(process.env.TMPDIR ?? process.env.TEMP, 'leftover')], { stdio: 'ignore', detached: true }).unref(); write({ ok: true }); }
