// Phase 2 probe 5: CTRL_BREAK while a program resumed from the debugger runs. Raw output.
// npx esbuild spike/spike10.ts --bundle --platform=node --outfile=dist/spike10.js && node scripts/run-detached.mjs dist/spike10.js
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Interrupter } from '../src/interrupt';

const exe = 'C:/Program Files/GNU Octave/Octave-11.1.0/mingw64/bin/octave-gui.exe';
const dir = path.join(os.tmpdir(), 'octave-probe10');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'brk_script.m'), 'a = 1;\nfor k = 1:300000000, end\ndone = 1;\n');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const intr = new Interrupter(m => console.log('[intr]', m));
  await intr.prepare();
  const p = spawn(exe, ['--no-gui', '--quiet', '--interactive', '--no-line-editing', '--no-history'], { cwd: dir, windowsHide: true, stdio: 'pipe' });
  const t0 = Date.now();
  p.stdout.on('data', d => console.log(`${Date.now() - t0} OUT ${JSON.stringify(String(d))}`));
  p.stderr.on('data', d => console.log(`${Date.now() - t0} ERR ${JSON.stringify(String(d))}`));
  p.on('exit', c => console.log('EXIT', c));
  const send = async (l: string, wait = 800) => { console.log(`${Date.now() - t0} >>> ${l}`); p.stdin.write(l + '\n'); await sleep(wait); };
  await send('PS1("<READY>"); PS2("<MORE>");', 1500);
  await send('dbstop("brk_script", "1");');
  await send('brk_script');
  await send('dbcont', 1500);
  console.log('--- break');
  await intr.interrupt(p.pid!);
  await sleep(1500);
  await send('isdebugmode()');
  await send('disp(k)');
  await send('dbstack');
  await send('dbquit');
  await send('isdebugmode()');
  console.log('--- break at top level while idle-running');
  await send('pause(5)', 1000);
  await intr.interrupt(p.pid!);
  await sleep(1000);
  await send('disp(42)');
  await send('exit', 1000);
  intr.dispose();
})();
