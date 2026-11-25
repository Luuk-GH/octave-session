// Phase 2 probe: how Octave behaves at breakpoints on pipes (prompts, dbstack, whos, stepping).
// node spike/spike6.js  -> prints every command with raw stdout/stderr as JSON strings.
const { spawn } = require('child_process');
const path = require('path');

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const testDir = path.join(__dirname, '..', 'test').split(path.sep).join('/');
const demo = `${testDir}/debug_demo.m`;
const helper = `${testDir}/debug_helper.m`;

const p = spawn(exe, ['--no-gui', '--quiet', '--interactive', '--no-line-editing', '--no-history'],
  { cwd: testDir, windowsHide: true, stdio: 'pipe' });
let out = '', err = '';
let waiter = null;
p.stdout.on('data', d => { out += d; check(); });
p.stderr.on('data', d => { err += d; });
function check() {
  if (waiter && /\x01OCT_(READY|MORE)\x02|debug> |K>> /.test(out)) { const w = waiter; waiter = null; setTimeout(w, 80); }
}
function send(line) {
  return new Promise(res => {
    out = ''; err = '';
    waiter = () => { console.log(`>>> ${line}\n  out=${JSON.stringify(out)}\n  err=${JSON.stringify(err)}`); res(); };
    p.stdin.write(line + '\n');
    check();
  });
}

(async () => {
  await send('PS1("\\x01OCT_READY\\x02"); PS2("\\x01OCT_MORE\\x02"); more off; page_screen_output(false);');
  await send(`dbstop("${demo}", "3")`);
  await send(`dbstop in debug_helper at 4`);
  await send(`dbstop("${demo}", "10")`);
  await send(`dbstop("${helper}", "9")`);
  await send('bp = dbstatus; for i=1:numel(bp), printf("%s|%s|%s\n", bp(i).name, bp(i).file, mat2str(bp(i).line)); end');
  await send(`run("${demo}")`);
  await send('isdebugmode()');
  await send('[st, idx] = dbstack(); disp(numel(st)); for i=1:numel(st), printf("%s|%s|%d|%d\n", st(i).file, st(i).name, st(i).line, st(i).column); end; disp(idx)');
  await send('dbstack');
  await send('whos');
  await send('dbstep');
  await send('dbstep');
  await send('dbcont');
  await send('dbstep in');
  await send('dbstep');
  await send('dbstep in');
  await send('[st, idx] = dbstack(); for i=1:numel(st), printf("%s|%s|%d\n", st(i).file, st(i).name, st(i).line); end; disp(idx)');
  await send('dbup');
  await send('[st, idx] = dbstack(); disp(idx)');
  await send('whos');
  await send('dbdown');
  await send('dbstep out');
  await send('dbcont');
  await send('dbcont');
  await send('x_in_debug = 5');
  await send('for q=1:2');
  await send('end');
  await send(`dbclear("${demo}", "10")`);
  await send('dbcont');
  await send('isdebugmode()');
  await send(`run("${demo}")`);
  await send('dbquit');
  await send('isdebugmode()');
  await send('dbclear all');
  await send('dbstop if error');
  await send(`run("${testDir}/error_demo.m")`);
  await send('isdebugmode()');
  await send('dbstack');
  await send('dbquit');
  await send('dbclear if error');
  await send('exit');
})();
p.on('exit', c => console.log('exit', c));
