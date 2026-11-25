// Final candidate: spawn octave-gui.exe --no-gui directly (qt, no launcher) + throwaway figure prelude.
const { spawn, execFile } = require('child_process');
const path = require('path');
const BIN = String.raw`C:\Program Files\GNU Octave\Octave-11.1.0\mingw64\bin`;
const READY = '\x01R\x02';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = (script, args) => new Promise(res => execFile('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args],
  { windowsHide: true }, (err, out, errOut) => res({ code: err ? err.code : 0, out: out.trim(), err: errOut.trim() })));
(async () => {
  const p = spawn(path.join(BIN, 'octave-gui.exe'), ['--no-gui', '--quiet', '--interactive', '--no-history', '--norc', '--no-line-editing'], { stdio: 'pipe', windowsHide: true });
  let buf = '', exited = false; p.stdout.on('data', d => buf += d); p.stderr.on('data', d => buf += d); p.on('exit', c => { exited = true; log('octave exit', c); });
  const wait = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !buf.includes(READY) && !exited) await sleep(25); return buf.includes(READY); };
  const run = async (cmd, ms = 15000) => { buf = ''; p.stdin.write(cmd + '\n'); await wait(ms); return buf.split(READY).join('<READY>'); };
  const wins = async (when) => { const w = await ps('windows.ps1', [String(p.pid), '1']); log(`  ${when}:`, JSON.stringify(w.out.split(/\r?\n/).filter(s => /Figure/.test(s)))); };
  const t0 = Date.now();
  log('startup+prelude:', JSON.stringify(await run(`PS1("${READY}"); PS2(""); more off; __h=figure("visible","on","position",[-3000 -3000 10 10]); drawnow; close(__h); clear __h`, 30000)), Date.now() - t0, 'ms');
  for (const label of ['busy loop', 'pause(30)']) {
    buf = ''; p.stdin.write(label === 'busy loop' ? 'k=0; while true, k=k+1; end\n' : 'pause(30)\n'); await sleep(1500);
    const h = await ps('ctrlc.ps1', [String(p.pid), String(process.pid), '1']);
    const back = await wait(6000);
    log(`CTRL_BREAK ${label}: helper=${h.code} back=${back} alive=${!exited} out=${JSON.stringify(buf)}`);
    if (exited) break;
  }
  if (!exited) {
    log('afterwards:', JSON.stringify(await run('disp(k>0)')));
    await run('figure(1); plot(1:10); drawnow;', 30000); await sleep(1000); await wins('figure after 1s');
    await sleep(7000); await wins('after 8s idle');
    buf = ''; p.stdin.write('while true, plot(rand(1,5)); drawnow; end\n'); await sleep(1500);
    const h = await ps('ctrlc.ps1', [String(p.pid), String(process.pid), '1']);
    log(`CTRL_BREAK during plot loop: back=${await wait(6000)} alive=${!exited}`);
  }
  p.kill(); log('done'); process.exit(0);
})();
