// Phase 2 probe 4: does a script edited between runs get re-parsed when it is called by name?
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const fwd = p => p.split(path.sep).join('/');
const srcDir = path.join(os.tmpdir(), 'octave-probe4');
fs.mkdirSync(srcDir, { recursive: true });
const script = path.join(srcDir, 'stale_script.m');
const fn = path.join(srcDir, 'stale_fn.m');
const S = fwd(srcDir);

const p = spawn(exe, ['--no-gui', '--quiet', '--interactive', '--no-line-editing', '--no-history'],
  { cwd: os.tmpdir(), windowsHide: true, stdio: 'pipe' });
let out = '', err = '', waiter = null;
p.stdout.on('data', d => { out += d; check(); });
p.stderr.on('data', d => { err += d; });
function check() {
  if (waiter && /(\x01OCT_(READY|MORE)\x02|debug> )$/.test(out)) { const w = waiter; waiter = null; setTimeout(w, 80); }
}
function send(line) {
  return new Promise(res => {
    out = ''; err = '';
    waiter = () => { console.log(`>>> ${line}\n  out=${JSON.stringify(out.replace(/\x01OCT_READY\x02/g, ''))} err=${JSON.stringify(err)}`); res(); };
    p.stdin.write(line + '\n');
    check();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await send('PS1("\\x01OCT_READY\\x02"); PS2("\\x01OCT_MORE\\x02"); more off; page_screen_output(false);');
  let v = 0;
  const edit = () => { v++; fs.writeFileSync(script, `disp("script v${v}"); stale_fn();\n`); fs.writeFileSync(fn, `function stale_fn()\n  disp("fn v${v}");\nend\n`); };
  edit();
  await send(`cd("${S}")`);
  await send('stale_script');
  for (const delay of [50, 300, 1100, 2100]) {
    edit(); await sleep(delay);
    console.log(`-- edited to v${v}, waited ${delay} ms, cwd = file dir`);
    await send('stale_script');
  }
  await send('cd ..');
  await send(`addpath("${S}")`);
  for (const delay of [50, 1100]) {
    edit(); await sleep(delay);
    console.log(`-- edited to v${v}, waited ${delay} ms, on path`);
    await send('stale_script');
  }
  edit(); await sleep(50);
  console.log(`-- edited to v${v}, after dbstop`);
  await send('dbstop("stale_fn", "2");');
  await send('stale_script');
  await send('dbcont');
  edit(); await sleep(50);
  console.log(`-- edited to v${v}, after rehash`);
  await send('rehash; stale_script');
  await send('dbcont');
  edit(); await sleep(50);
  console.log(`-- edited to v${v}, after clear names`);
  await send('clear stale_script stale_fn; stale_script');
  await send('dbstatus');
  await send('exit');
})();
p.on('exit', c => console.log('exit', c));
