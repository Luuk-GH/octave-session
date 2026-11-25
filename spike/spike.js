// Windows spike: interrupt + plot windows + sentinel prompt + non-ASCII paths.
// Run via run-spike.js so this process has NO console (like the VS Code extension host).
const { spawn, execFile } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const BIN = String.raw`C:\Program Files\GNU Octave\Octave-11.1.0\mingw64\bin`;
const READY = '\x01R\x02';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = (script, args) => new Promise(res => execFile('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args],
  { windowsHide: true }, (err, out, errOut) => res({ code: err ? err.code : 0, out: out.trim(), err: errOut.trim() })));

class Oct {
  constructor(exe, args) {
    this.buf = ''; this.chunks = [];
    this.p = spawn(path.join(BIN, exe), args, { windowsHide: true, stdio: 'pipe' });
    const on = (s) => d => { const t = d.toString(); this.buf += t; this.chunks.push({ t: Date.now(), s, d: t }); };
    this.p.stdout.on('data', on('out')); this.p.stderr.on('data', on('err'));
    this.exited = false; this.p.on('exit', c => { this.exited = true; this.code = c; });
  }
  send(line) { this.p.stdin.write(line + '\n'); }
  async waitFor(re, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(this.buf)) return true; if (this.exited) return false; await sleep(25); } return false; }
  async run(cmd, ms = 15000) { this.buf = ''; this.send(cmd); const ok = await this.waitFor(new RegExp(READY), ms); const out = this.buf.split(READY).join('<READY>'); return { ok, out }; }
  kill() { try { this.p.kill(); } catch {} }
}

async function start(exe, extra) {
  const o = new Oct(exe, ['--quiet', '--interactive', '--no-history', '--norc', ...extra]);
  o.send(`PS1("${READY}"); PS2(""); more off; page_screen_output(false);`);
  await o.waitFor(new RegExp(READY), 30000); o.buf = '';
  return o;
}

async function interruptTests() {
  log('=== INTERRUPT (octave-cli) ===');
  const o = await start('octave-cli.exe', ['--no-line-editing']);
  // streaming
  o.buf = ''; o.chunks = [];
  const r0 = await o.run('for i=1:3, printf("tick %d\\n", i); pause(0.5); end');
  const ticks = o.chunks.filter(c => /tick/.test(c.d)).map(c => c.t);
  log('streaming chunks:', ticks.length, 'gaps(ms):', ticks.slice(1).map((t, i) => t - ticks[i]).join(','), 'ok=', r0.ok);
  // error -> stderr, still get READY
  const r1 = await o.run('error("boom")'); log('error case ok=', r1.ok, JSON.stringify(r1.out));
  for (const [name, cmd] of [['busy loop', 'k=0; while true, k=k+1; end'], ['pause(30)', 'pause(30)'], ['Ctrl+C a 2nd time', 'while true, end']]) {
    o.buf = ''; o.send(cmd); await sleep(1500);
    const t0 = Date.now();
    const h = await ps('ctrlc.ps1', [String(o.p.pid), String(process.pid)]);
    const back = await o.waitFor(new RegExp(READY), 8000);
    log(`${name}: helper code=${h.code} ${h.err} | prompt back=${back} after ${Date.now() - t0}ms | alive=${!o.exited} | out=${JSON.stringify(o.buf.slice(0, 120))}`);
  }
  const r2 = await o.run('disp(6*7)'); log('after interrupts:', JSON.stringify(r2.out), 'alive=', !o.exited);
  const r3 = await o.run('k'); log('workspace kept (k):', JSON.stringify(r3.out.slice(0, 60)));
  // guard: target console should NOT be shared with us
  o.kill();
}

async function plotTest(label, exe, extra, toolkit) {
  log(`=== PLOT ${label} ===`);
  const o = await start(exe, extra);
  const tk = await o.run(toolkit ? `graphics_toolkit("${toolkit}"); disp(graphics_toolkit)` : 'disp(graphics_toolkit)', 20000);
  log('toolkit:', JSON.stringify(tk.out));
  const t0 = Date.now();
  const r = await o.run('h=figure(1); plot(1:10, (1:10).^2); title("spike"); drawnow;', 30000);
  log('plot cmd ok=', r.ok, 'in', Date.now() - t0, 'ms', JSON.stringify(r.out.slice(0, 200)));
  for (const wait of [1000, 7000]) {
    await sleep(wait);
    const w = await ps('windows.ps1', [String(o.p.pid)]);
    log(`windows after +${wait}ms idle:`, JSON.stringify(w.out || '(none)'), w.err);
  }
  const r2 = await o.run('plot(sin(0:0.1:10)); drawnow; pause(0.2); close all; disp(numel(get(0,"children")))', 20000);
  log('replot+close ok=', r2.ok, JSON.stringify(r2.out));
  await sleep(500);
  const w2 = await ps('windows.ps1', [String(o.p.pid)]);
  log('windows after close all:', JSON.stringify(w2.out || '(none)'));
  o.kill();
}

async function nonAsciiTest() {
  log('=== NON-ASCII PATH ===');
  const dir = path.join(os.tmpdir(), 'octspike_tëst_ü');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello_spike.m'), 'disp("hello from non-ascii dir")\n');
  const o = await start('octave-cli.exe', ['--no-line-editing']);
  const p = dir.split(path.sep).join('/');
  const a = await o.run(`run("${p}/hello_spike.m")`); log('run():', JSON.stringify(a.out));
  const b = await o.run(`disp(exist("${p}", "dir"))`); log('exist dir:', JSON.stringify(b.out));
  const c = await o.run(`cd("${p}"); disp(pwd)`); log('cd + pwd:', JSON.stringify(c.out));
  o.kill();
}

(async () => {
  log('runner pid', process.pid, 'stdout isTTY', !!process.stdout.isTTY);
  try { await interruptTests(); } catch (e) { log('ERR', e); }
  try { await plotTest('octave-cli fltk, --no-line-editing', 'octave-cli.exe', ['--no-line-editing']); } catch (e) { log('ERR', e); }
  try { await plotTest('octave-cli fltk, line editing on', 'octave-cli.exe', []); } catch (e) { log('ERR', e); }
  try { await plotTest('octave.exe --no-gui qt', 'octave.exe', ['--no-gui', '--no-line-editing']); } catch (e) { log('ERR', e); }
  try { await nonAsciiTest(); } catch (e) { log('ERR', e); }
  log('done'); process.exit(0);
})();
