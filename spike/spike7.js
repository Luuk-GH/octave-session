// Phase 2 probe 2: dbstop by path, structured dbstack, evalin("caller") from a helper at the debug prompt.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const fwd = p => p.split(path.sep).join('/');
const testDir = fwd(path.join(__dirname, '..', 'test'));
const demo = `${testDir}/debug_demo.m`;
const helper = `${testDir}/debug_helper.m`;
const helpDir = path.join(os.tmpdir(), 'octave-probe-helpers');
fs.mkdirSync(helpDir, { recursive: true });
fs.writeFileSync(path.join(helpDir, 'vsc_probe_vars.m'), [
  'function vsc_probe_vars()',
  '  w = evalin("caller", "whos");',
  '  for i = 1:numel(w)',
  '    printf("%s|%s|%s\\n", w(i).name, mat2str(w(i).size), w(i).class);',
  '  end',
  'end', ''].join('\n'));

const cwd = os.tmpdir();  // NOT the test folder: files are off the path
const p = spawn(exe, ['--no-gui', '--quiet', '--interactive', '--no-line-editing', '--no-history'],
  { cwd, windowsHide: true, stdio: 'pipe' });
let out = '', err = '', waiter = null;
p.stdout.on('data', d => { out += d; check(); });
p.stderr.on('data', d => { err += d; });
function check() {
  if (waiter && /(\x01OCT_(READY|MORE)\x02|debug> )$/.test(out)) { const w = waiter; waiter = null; setTimeout(w, 80); }
}
function send(line) {
  return new Promise(res => {
    out = ''; err = '';
    waiter = () => { console.log(`>>> ${line}\n  out=${JSON.stringify(out)}\n  err=${JSON.stringify(err)}`); res(); };
    p.stdin.write(line + '\n');
    check();
  });
}
const bpList = 'bp = dbstatus; for i=1:numel(bp), printf("%s|%s|%s\\n", bp(i).name, bp(i).file, mat2str(bp(i).line)); end; clear bp i';

(async () => {
  await send('PS1("\\x01OCT_READY\\x02"); PS2("\\x01OCT_MORE\\x02"); more off; page_screen_output(false);');
  await send(`addpath("${fwd(helpDir)}")`);
  await send(`dbstop("${demo.replace(/\.m$/, '')}", 3)`);
  await send(`dbstop in "${demo}" at 3`);
  await send(`dbstop("${demo.replace(/\//g, '\\\\')}", "3")`);
  await send(`dbstop("in", "${demo}", "at", "3")`);
  await send(bpList);
  // cd-free fallback: temporarily addpath the file's folder
  await send(`addpath("${testDir}"); dbstop("debug_demo", "3"); dbstop("debug_demo", "10"); dbstop("debug_helper", "9"); rmpath("${testDir}")`);
  await send(bpList);
  await send(`run("${demo}")`);
  await send('[vsc_st, vsc_idx] = dbstack(); for vsc_i=1:numel(vsc_st), printf("%s|%s|%d|%d\\n", vsc_st(vsc_i).file, vsc_st(vsc_i).name, vsc_st(vsc_i).line, vsc_st(vsc_i).column); end; disp(vsc_idx); clear vsc_st vsc_idx vsc_i');
  await send('vsc_probe_vars()');
  await send('dbstep');
  await send('dbstep');
  await send('dbstep');
  await send('dbstep');
  await send('dbstep in');
  await send('dbstep in');
  await send('dbstack');
  await send('vsc_probe_vars()');
  await send('dbup');
  await send('vsc_probe_vars()');
  await send('dbstack');
  await send('dbdown');
  await send('dbstep out');
  await send('dbstep out');
  await send('for q=1:2');
  await send('end');
  await send('dbcont');
  await send('dbcont');
  await send('dbcont');
  await send(bpList);
  await send(`fprintf("debug> ")`);
  await send('exit');
})();
p.on('exit', c => console.log('exit', c));
