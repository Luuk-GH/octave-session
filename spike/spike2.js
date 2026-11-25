// Follow-up spike: which interrupt event works, and why figures were invisible.
// Usage: node run-spike.js spike2.js   (detached runner = new process group, no console)
//        SPIKE_NOGROUP=1 node run-spike.js spike2.js   (hidden console, no new process group)
const { spawn, execFile } = require('child_process');
const path = require('path');

const BIN = String.raw`C:\Program Files\GNU Octave\Octave-11.1.0\mingw64\bin`;
const READY = '\x01R\x02';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = (script, args) => new Promise(res => execFile('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args],
  { windowsHide: true }, (err, out, errOut) => res({ code: err ? err.code : 0, out: out.trim(), err: errOut.trim() })));

// Keep this runner alive if a console ctrl event also reaches it (shared-console case).
process.on('SIGINT', () => log('runner got SIGINT (shared console)'));
process.on('SIGBREAK', () => log('runner got SIGBREAK (shared console)'));

class Oct {
  constructor(exe, args, opts) {
    this.buf = '';
    this.p = spawn(path.join(BIN, exe), args, { stdio: 'pipe', ...opts });
    this.p.stdout.on('data', d => { this.buf += d; });
    this.p.stderr.on('data', d => { this.buf += d; });
    this.exited = false; this.p.on('exit', c => { this.exited = true; this.code = c; });
  }
  send(line) { this.p.stdin.write(line + '\n'); }
  async waitFor(re, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(this.buf)) return true; if (this.exited) return false; await sleep(25); } return false; }
  async run(cmd, ms = 15000) { this.buf = ''; this.send(cmd); const ok = await this.waitFor(new RegExp(READY), ms); return { ok, out: this.buf.split(READY).join('<READY>') }; }
}

async function start(exe, extra, opts = { windowsHide: true }) {
  const o = new Oct(exe, ['--quiet', '--interactive', '--no-history', '--norc', ...extra], opts);
  o.send(`PS1("${READY}"); PS2(""); more off;`);
  await o.waitFor(new RegExp(READY), 30000); o.buf = '';
  return o;
}

async function interrupt(evName, ev) {
  log(`=== INTERRUPT via ${evName} ===`);
  const o = await start('octave-cli.exe', ['--no-line-editing']);
  for (const [name, cmd] of [['busy loop', 'k=0; while true, k=k+1; end'], ['pause(30)', 'pause(30)']]) {
    o.buf = ''; o.send(cmd); await sleep(1500);
    const t0 = Date.now();
    const h = await ps('ctrlc.ps1', [String(o.p.pid), process.env.SPIKE_NOGROUP ? '0' : String(process.pid), String(ev)]);
    const back = await o.waitFor(new RegExp(READY), 6000);
    log(`${name}: helper=${h.code} ${h.err} | prompt back=${back} (${Date.now() - t0}ms incl. ~helper startup) | alive=${!o.exited} code=${o.code} | out=${JSON.stringify(o.buf.slice(0, 100))}`);
    if (o.exited) break;
  }
  if (!o.exited) { const r = await o.run('disp(6*7); disp(k>0)', 4000); log('afterwards:', JSON.stringify(r.out), 'ok=', r.ok); }
  o.p.kill();
}

async function plot(label, exe, extra, opts) {
  log(`=== PLOT ${label} ===`);
  const o = await start(exe, extra, opts);
  const show = async (when) => { const w = await ps('windows.ps1', [String(o.p.pid), '1']); log(`  ${when}:`, JSON.stringify(w.out.split(/\r?\n/).filter(s => /Figure|spike/i.test(s)))); };
  await o.run('graphics_toolkit', 10000).then(r => log('  toolkit', JSON.stringify(r.out)));
  await o.run('figure(1); plot(1:10); title("spike"); drawnow;', 30000);
  await sleep(1000); await show('figure 1 after 1s');
  await sleep(6000); await show('figure 1 after 7s idle');
  await o.run('figure(2); plot(rand(5)); drawnow;', 30000);
  await sleep(1000); await show('figure 2 (second window) after 1s');
  o.p.kill();
}

(async () => {
  log('runner pid', process.pid, 'mode', process.env.SPIKE_NOGROUP ? 'hidden console, same group' : 'detached (new process group)');
  if (!process.env.SPIKE_PLOTS_ONLY) {
    await interrupt('CTRL_C_EVENT', 0);
    await interrupt('CTRL_BREAK_EVENT', 1);
  }
  if (!process.env.SPIKE_NOGROUP) {
    await plot('octave-cli fltk (windowsHide)', 'octave-cli.exe', ['--no-line-editing'], { windowsHide: true });
    await plot('octave.exe --no-gui qt (windowsHide)', 'octave.exe', ['--no-gui', '--no-line-editing'], { windowsHide: true });
    await plot('octave.exe --no-gui qt (no windowsHide)', 'octave.exe', ['--no-gui', '--no-line-editing'], { windowsHide: false });
  }
  log('done'); process.exit(0);
})();
