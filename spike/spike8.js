// Phase 2 probe 3: breakpoints set with a temporary addpath, script run by name via evalin("base"),
// helper frames, edits after setting breakpoints, line adjustment.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const fwd = p => p.split(path.sep).join('/');
const work = path.join(os.tmpdir(), 'octave-probe3');
const helpDir = path.join(work, 'helpers');
const srcDir = path.join(work, 'src dir');
fs.mkdirSync(helpDir, { recursive: true });
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(helpDir, '__vsc_run__.m'), [
  'function __vsc_run__(file)',
  '  [d, name] = fileparts(file);',
  '  old = pwd();',
  '  cd(d);',
  '  unwind_protect',
  '    evalin("base", name);',
  '  unwind_protect_cleanup',
  '    if (strcmp(pwd(), d)) cd(old); end',
  '  end_unwind_protect',
  'end', ''].join('\n'));
const script = path.join(srcDir, 'probe_script.m');
fs.writeFileSync(script, ['% comment line 1', 'a = 1;', 'clear all', 'b = probe_fn(2);', 'disp(b)', ''].join('\n'));
fs.writeFileSync(path.join(srcDir, 'probe_fn.m'), ['function r = probe_fn(x)', '  % comment', '  r = x * 10;', 'end', ''].join('\n'));

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
    waiter = () => { console.log(`>>> ${line}\n  out=${JSON.stringify(out)}\n  err=${JSON.stringify(err)}`); res(); };
    p.stdin.write(line + '\n');
    check();
  });
}
const S = fwd(srcDir);
const setBp = (name, line) => `addpath("${S}"); vsc_l = dbstop("${name}", "${line}"); rmpath("${S}"); disp(vsc_l); clear vsc_l`;

(async () => {
  await send('PS1("\\x01OCT_READY\\x02"); PS2("\\x01OCT_MORE\\x02"); more off; page_screen_output(false);');
  await send(`addpath("${fwd(helpDir)}")`);
  await send(setBp('probe_script', 1));
  await send(setBp('probe_script', 4));
  await send(setBp('probe_fn', 2));
  await send(`__vsc_run__("${fwd(script)}")`);
  await send('[st, idx] = dbstack(); for i=1:numel(st), printf("%s|%s|%d\\n", st(i).file, st(i).name, st(i).line); end; disp(idx); clear st idx i');
  await send('dbcont');
  await send('dbstack');
  await send('dbstep out');
  await send('dbstep out');
  await send('dbstack');
  await send('dbcont');
  await send('pwd');
  // modify the function file after setting breakpoints: are they kept?
  fs.writeFileSync(path.join(srcDir, 'probe_fn.m'), ['function r = probe_fn(x)', '  % comment changed', '  r = x * 100;', 'end', ''].join('\n'));
  await new Promise(r => setTimeout(r, 1100));
  await send(`__vsc_run__("${fwd(script)}")`);
  await send('dbcont');
  await send('dbcont');
  // re-apply after modification
  await send(setBp('probe_fn', 3));
  await send(`__vsc_run__("${fwd(script)}")`);
  await send('dbcont');
  await send('dbcont');
  // error inside the script: called-from lines
  await send('dbclear all');
  fs.writeFileSync(script, ['x = [1 2];', 'y = x(3);', ''].join('\n'));
  await new Promise(r => setTimeout(r, 1100));
  await send(`__vsc_run__("${fwd(script)}")`);
  await send('pwd');
  await send('exit');
})();
p.on('exit', c => console.log('exit', c));
