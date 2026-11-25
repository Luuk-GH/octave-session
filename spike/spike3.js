// Follow-up: qt toolkit under `octave.exe --no-gui` — which process owns the figures, are they responsive?
// Also: does a throwaway figure at startup fix the "first window hidden" effect of windowsHide (fltk)?
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

async function descendants(pid) {
  const out = await psCmd(`$all = Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name; $q=@(${pid}); $r=@(); while($q.Count){ $p=$q[0]; $q=$q[1..$q.Count]; $all | ? { $_.ParentProcessId -eq $p } | % { $r += "$($_.ProcessId):$($_.Name)"; $q += $_.ProcessId } }; $r -join ','`);
  return out ? out.split(',') : [];
}

async function session(label, exe, args, opts, prelude) {
  log(`=== ${label} ===`);
  const p = spawn(path.join(BIN, exe), ['--quiet', '--interactive', '--no-history', '--norc', ...args], { stdio: 'pipe', ...opts });
  let buf = ''; p.stdout.on('data', d => buf += d); p.stderr.on('data', d => buf += d);
  const run = async (cmd, ms = 30000) => { buf = ''; p.stdin.write(cmd + '\n'); const t0 = Date.now(); while (Date.now() - t0 < ms && !buf.includes(READY)) await sleep(25); return buf.split(READY).join('<READY>'); };
  await run(`PS1("${READY}"); PS2(""); more off;`);
  const kids = await descendants(p.pid);
  log('  pid', p.pid, 'descendants:', kids.join(' ') || '(none)');
  const pids = [p.pid, ...kids.map(k => +k.split(':')[0])];
  const wins = async (when) => { const all = []; for (const id of pids) { const w = await ps('windows.ps1', [String(id), '1']); all.push(...w.out.split(/\r?\n/).filter(s => /Figure/i.test(s)).map(s => `${id}:${s}`)); } log(`  ${when}:`, JSON.stringify(all)); };
  if (prelude) log('  prelude:', JSON.stringify(await run(prelude)));
  log('  toolkit:', JSON.stringify(await run('disp(graphics_toolkit)')));
  const t0 = Date.now(); await run('figure(1); plot(1:10); drawnow;'); log('  first plot took', Date.now() - t0, 'ms');
  await sleep(1000); await wins('after 1s');
  await sleep(7000); await wins('after 8s idle at prompt');
  p.kill();
}

(async () => {
  await session('octave.exe --no-gui (qt), windowsHide', 'octave.exe', ['--no-gui', '--no-line-editing'], { windowsHide: true });
  await session('octave-cli fltk + throwaway figure prelude', 'octave-cli.exe', ['--no-line-editing'], { windowsHide: true },
    'set(0,"defaultfigurevisible","on"); __h=figure("visible","on","position",[-2000 -2000 10 10]); drawnow; close(__h); clear __h');
  await session('octave-gui.exe --no-gui (qt), windowsHide', 'octave-gui.exe', ['--no-gui', '--no-line-editing'], { windowsHide: true });
  log('done'); process.exit(0);
})();
