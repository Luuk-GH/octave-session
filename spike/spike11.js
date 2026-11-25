// Completion / signature probe: completion_matches, __list_functions__, get_help_text formats.
// node spike/spike11.js
const { spawn } = require('child_process');
const path = require('path');

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const testDir = path.join(__dirname, '..', 'test').split(path.sep).join('/');
const p = spawn(exe, ['--no-gui', '--quiet', '--interactive', '--no-line-editing', '--no-history'],
  { cwd: testDir, windowsHide: true, stdio: 'pipe' });
let out = '', err = '', waiter = null, t0 = 0;
p.stdout.on('data', d => { out += d; check(); });
p.stderr.on('data', d => { err += d; });
function check() {
  if (waiter && /\x01OCT_READY\x02$/.test(out)) { const w = waiter; waiter = null; setTimeout(w, 40); }
}
function send(line, max = 1500) {
  return new Promise(res => {
    out = ''; err = ''; t0 = Date.now();
    waiter = () => {
      const o = out.replace(/\x01OCT_READY\x02/g, '');
      console.log(`>>> ${line}   (${Date.now() - t0} ms)\n  out=${JSON.stringify(o.length > max ? o.slice(0, max) + '…[' + o.length + ']' : o)}\n  err=${JSON.stringify(err)}`);
      res();
    };
    p.stdin.write(line + '\n');
  });
}

(async () => {
  await send('PS1("\\x01OCT_READY\\x02"); more off; page_screen_output(false);');
  await send('my_var = 1; my_struct.name = 2; my_struct.nested.deep = 3;');
  await send('m = completion_matches("pl"); disp(size(m)); disp(m(1:min(8,rows(m)),:))');
  await send('m = completion_matches("my_"); disp(m)');
  await send('m = completion_matches("my_struct.n"); disp(m)');
  await send('m = completion_matches("fo"); disp(m)');
  await send('m = completion_matches("debug_h"); disp(m)');
  await send('m = completion_matches("p"); disp(size(m))');
  await send('m = completion_matches(""); disp(size(m))');
  await send('f = __list_functions__(); disp(size(f)); disp(class(f)); disp(f(1:5))');
  await send('k = iskeyword(); disp(size(k)); disp(k(1:6))');
  await send('[t, fmt] = get_help_text("plot"); disp(fmt); disp(t(1:min(900,end)))', 2500);
  await send('[t, fmt] = get_help_text("zeros"); disp(fmt); disp(t(1:min(600,end)))', 2500);
  await send('[t, fmt] = get_help_text("debug_helper"); disp(fmt); disp(t)');
  await send('[t, fmt] = get_help_text("sin"); disp(fmt); disp(t(1:min(400,end)))');
  await send('[t, fmt] = get_help_text("nosuchfunction_xyz"); disp(fmt); disp(size(t))');
  await send('[t, fmt] = get_help_text("my_var"); disp(fmt); disp(size(t))');
  await send('disp(which("plot")); disp(which("zeros")); disp(which("debug_helper"))');
  await send('exit');
})();
p.on('exit', c => console.log('exit', c));
