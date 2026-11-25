// Follow-up: CTRL_BREAK interrupt and process cleanup when using `octave.exe --no-gui` (launcher -> octave-gui.exe).
const { spawn, execFile } = require('child_process');
const path = require('path');
const BIN = String.raw`C:\Program Files\GNU Octave\Octave-11.1.0\mingw64\bin`;
const READY = '\x01R\x02';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const psCmd = (cmd) => new Promise(res => execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true }, (e, o) => res(o.trim())));
const ps = (script, args) => new Promise(res => execFile('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args],
  { windowsHide: true }, (err, out, errOut) => res({ code: err ? err.code : 0, out: out.trim(), err: errOut.trim() })));
const alive = async (pid) => (await psCmd(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`)) === 'yes';

(async () => {
  const p = spawn(path.join(BIN, 'octave.exe'), ['--no-gui', '--quiet', '--interactive', '--no-history', '--norc', '--no-line-editing'], { stdio: 'pipe', windowsHide: true });
  let buf = '', exited = false; p.stdout.on('data', d => buf += d); p.stderr.on('data', d => buf += d); p.on('exit', c => { exited = true; log('launcher exit', c); });
  const wait = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !buf.includes(READY)) await sleep(25); return buf.includes(READY); };
  const run = async (cmd, ms = 15000) => { buf = ''; p.stdin.write(cmd + '\n'); await wait(ms); return buf.split(READY).join('<READY>'); };
  await run(`PS1("${READY}"); PS2(""); more off;`);
  const child = +(await psCmd(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${p.pid} and Name='octave-gui.exe'").ProcessId`));
  log('launcher', p.pid, 'interpreter', child);
  for (const [target, label] of [[p.pid, 'attach to launcher console'], [child, 'attach to interpreter console']]) {
    buf = ''; p.stdin.write('k=0; while true, k=k+1; end\n'); await sleep(1500);
    const h = await ps('ctrlc.ps1', [String(target), String(process.pid), '1']);
    const back = await wait(6000);
    log(`${label}: helper=${h.code} ${h.err} back=${back} launcherAlive=${!exited} interpAlive=${await alive(child)}`);
    if (exited) break;
  }
  if (!exited) log('afterwards:', JSON.stringify(await run('disp(k>0)', 4000)));
  log('killing launcher with p.kill()'); p.kill(); await sleep(1500);
  log('interpreter still alive after p.kill():', await alive(child));
  if (await alive(child)) { await psCmd(`taskkill /PID ${child} /T /F`); await sleep(500); log('after taskkill:', await alive(child)); }
  log('done'); process.exit(0);
})();
