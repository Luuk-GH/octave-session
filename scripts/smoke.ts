// Smoke test for the VS Code-free session core.
// Build + run: npm run smoke   (runs detached without a console, like the VS Code extension host)
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Interrupter } from '../src/interrupt';
import { resolveOctave } from '../src/locator';
import { OctaveProcess } from '../src/octaveProcess';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const launch = resolveOctave(process.env.OCTAVE_EXE);
  console.log('launch:', launch.exe, launch.args.join(' '), `(${launch.note})`);
  const interrupter = new Interrupter(m => console.log('[log]', m));
  const helper = interrupter.prepare();

  const oct = new OctaveProcess(launch, interrupter, m => console.log('[log]', m));
  let out = '';
  oct.on('output', (t, s) => { out += s === 'err' ? `<err>${t}</err>` : t; });
  const run = async (line: string) => { out = ''; const kind = await oct.sendLine(line); return { kind, out }; };

  const t0 = Date.now();
  oct.start(process.cwd());
  await oct.ready;
  check('startup', oct.state === 'idle', `${Date.now() - t0} ms`);

  let r = await run('x = 6*7');
  check('simple command', r.kind === 'ready' && /x = 42/.test(r.out), JSON.stringify(r.out));

  r = await run('error("boom")');
  check('error reaches stderr before prompt', r.kind === 'ready' && /<err>error: boom/.test(r.out), JSON.stringify(r.out));

  r = await run('for i = 1:2');
  check('continuation prompt (PS2)', r.kind === 'more', r.kind);
  r = await run('printf("i=%d\\n", i)');
  r = await run('end');
  check('block completes', r.kind === 'ready' && /i=1\s+i=2/.test(r.out), JSON.stringify(r.out));

  // queued lines run in order
  const a = oct.sendLine('q1 = 1;'), b = oct.sendLine('q2 = q1 + 1;'); out = '';
  await Promise.all([a, b]);
  r = await run('disp(q2)');
  check('queued lines', /2/.test(r.out), JSON.stringify(r.out));

  // streaming
  const stamps: number[] = [];
  const onOut = (t: string) => { if (/tick/.test(t)) { stamps.push(Date.now()); } };
  oct.on('output', onOut);
  await run('for k=1:3, printf("tick\\n"); pause(0.4); end');
  oct.off('output', onOut);
  check('output streams while running', stamps.length === 3 && stamps[2] - stamps[0] > 600, `gaps ${stamps.slice(1).map((s, i) => s - stamps[i])}`);

  // interrupt
  await helper;
  for (const cmd of ['n = 0; while true, n = n + 1; end', 'pause(30)']) {
    out = '';
    const p = oct.sendLine(cmd);
    await sleep(1200);
    const ti = Date.now();
    await oct.interrupt();
    const kind = await Promise.race([p, sleep(8000).then(() => 'timeout' as const)]);
    check(`interrupt: ${cmd}`, kind === 'ready' && oct.state === 'idle', `${kind} after ${Date.now() - ti} ms`);
  }
  r = await run('disp(n > 0)');
  check('workspace kept after interrupt', /1/.test(r.out), JSON.stringify(r.out));

  // figures: visible + responsive while idle
  await run('figure(1); plot(1:10); drawnow;');
  await sleep(6500);
  const wins = await new Promise<string>(res => execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'spike', 'windows.ps1'), String(oct.pid)],
    { windowsHide: true }, (_e, o) => res(o.trim())));
  check('figure visible and responsive after 6.5 s idle', /Figure 1\|visible=True\|hung=False/.test(wins), JSON.stringify(wins));
  await run('close all');

  // non-ASCII path
  const dir = path.join(os.tmpdir(), 'octave smoke tëst ü');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'smoke_script.m');
  fs.writeFileSync(file, 'smoke_val = 123;\ndisp("ünïcode ok")\n', 'utf8');
  r = await run(`run("${file.split(path.sep).join('/')}")`);
  check('run() from non-ASCII path, UTF-8 output', /ünïcode ok/.test(r.out), JSON.stringify(r.out));

  oct.dispose();
  interrupter.dispose();
  const exited = await Promise.race([new Promise(res => oct.on('exit', () => res(true))), sleep(5000).then(() => false)]);
  check('clean exit', exited === true || oct.state === 'exited');
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
