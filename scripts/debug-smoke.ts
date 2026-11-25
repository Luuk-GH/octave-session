// Smoke test for the debugger core (no VS Code): debug prompt detection, helpers, breakpoint sync.
// Build + run: npm run smoke:debug   (runs detached without a console, like the extension host)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BreakpointSync } from '../src/breakpoints';
import { parseRecords, writeHelpers } from '../src/helpers';
import { Interrupter } from '../src/interrupt';
import { resolveOctave } from '../src/locator';
import { OctaveProcess } from '../src/octaveProcess';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const fwd = (p: string) => p.replace(/\\/g, '/');

async function main(): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'octave-dbg-smoke-'));
  const src = path.join(work, 'src dir');
  fs.mkdirSync(src);
  const script = path.join(src, 'dbg_script.m');
  const fn = path.join(src, 'dbg_fn.m');
  fs.writeFileSync(script, [
    '% comment',                 // 1
    'a = 1;',                    // 2
    's.x = 5; s.y = "hi";',      // 3
    'r = dbg_fn(a);',            // 4
    'disp(r)',                   // 5
    'for k = 1:200000000, end',  // 6  (long loop, for pause)
    'done = 1;',                 // 7
    ''].join('\n'));
  fs.writeFileSync(fn, ['function out = dbg_fn(x)', '  y = x * 10;', '  out = y + 1;', 'end', ''].join('\n'));

  const interrupter = new Interrupter(m => console.log('[log]', m));
  const helper = interrupter.prepare();
  const oct = new OctaveProcess(resolveOctave(process.env.OCTAVE_EXE), interrupter, m => console.log('[log]', m));
  let out = '';
  oct.on('output', (t, s) => { out += s === 'err' ? `<err>${t}</err>` : t; });
  const prompts: string[] = [];
  oct.on('prompt', (k, hidden) => { if (!hidden) { prompts.push(k); } });
  const bps = new BreakpointSync(() => oct, m => console.log('[bp]', m));

  oct.start(os.tmpdir());
  await oct.ready;
  await oct.query(`addpath("${fwd(writeHelpers(path.join(work, 'helpers')))}");`);

  bps.set(script, [1, 4]);
  bps.set(fn, [3]);
  bps.flush();
  const r1 = await bps.result(script)!, r2 = await bps.result(fn)!;
  check('breakpoint on a comment line moves to the next statement', r1.get(1) === 2, JSON.stringify([...r1]));
  check('breakpoint in a function file', r2.get(3) === 3, JSON.stringify([...r2]));

  let kind: string = await oct.sendLine(`__vsc_run__("${fwd(script)}")`);
  check('run stops at the first breakpoint (debug prompt)', kind === 'debug' && oct.state === 'debug', `${kind} / ${oct.state}`);
  check('stop message reaches the output', /stopped in dbg_script at line 2/.test(out), JSON.stringify(out));
  check('"debug> " is not shown as output', !/debug> /.test(out));

  const stack = async () => {
    const r = await oct.query('__vsc_stack__();');
    return parseRecords(r.out);
  };
  let st = await stack();
  check('stack: top frame is the script line', st[0]?.[0] === 'F' && st[0][2] === 'dbg_script' && st[0][3] === '2', JSON.stringify(st));
  check('stack: helper frame below is reported', st.some(f => f[2] === '__vsc_run__'));

  kind = await oct.sendLine('dbcont');
  check('dbcont runs to the next breakpoint', kind === 'debug' && /line 4/.test(out.slice(-300)), kind);
  let r = await oct.query('__vsc_vars__();');
  const names = parseRecords(r.out).map(f => f[0]);
  check('variables of the script (base workspace)', names.includes('a') && names.includes('s'), JSON.stringify(names));
  r = await oct.query(`__vsc_vars__('s');`);
  const kids = parseRecords(r.out);
  check('struct children', kids.length === 2 && kids[0][0] === 'x' && kids[0][1] === '5' && kids[1][1] === '"hi"', JSON.stringify(kids));

  kind = await oct.sendLine('dbstep in');
  kind = await oct.sendLine('dbcont');
  st = await stack();
  check('stops inside the function', st[0]?.[2] === 'dbg_fn' && st[0][3] === '3', JSON.stringify(st.slice(0, 2)));
  r = await oct.query('__vsc_vars__();');
  check('function frame variables', JSON.stringify(parseRecords(r.out).map(f => f[0])) === '["x","y"]', JSON.stringify(parseRecords(r.out)));
  void oct.query('dbup(1)');
  r = await oct.query('__vsc_vars__();');
  check('dbup, then the helper sees the caller frame', parseRecords(r.out).some(f => f[0] === 's'), JSON.stringify(parseRecords(r.out).map(f => f[0])));
  st = await stack();
  check('stack is unchanged after dbup', st[0]?.[2] === 'dbg_fn', JSON.stringify(st.slice(0, 1)));
  void oct.query('dbdown(1)');
  r = await oct.query('__vsc_vars__(\'y\', "self");');
  check('evaluate (self) after dbdown', parseRecords(r.out)[0]?.[1] === '10', JSON.stringify(parseRecords(r.out)));
  r = await oct.query(`__vsc_vars__('disp', "hover");`);
  check('hover does not call functions', parseRecords(r.out).length === 0 && !r.out.includes('error'), JSON.stringify(r));
  r = await oct.query(`__vsc_vars__('nope + 1', "self");`);
  check('bad expression gives an ERR record and stays in the debugger', parseRecords(r.out)[0]?.[0] === 'ERR' && r.kind === 'debug', JSON.stringify(r));

  kind = await oct.sendLine('dbquit');
  check('dbquit returns to the top level', kind === 'ready' && oct.state === 'idle', kind);
  r = await oct.query('disp(pwd())');
  check('working folder restored after dbquit', fwd(r.out.trim()).toLowerCase() === fwd(os.tmpdir()).toLowerCase(), r.out.trim());

  // interrupt while a debugged program runs: aborts back to the top level
  bps.set(script, [5]); bps.set(fn, []); bps.flush();
  kind = await oct.sendLine(`__vsc_run__("${fwd(script)}")`);
  const running = oct.sendLine('dbcont');
  await helper;
  await sleep(1500);
  await oct.interrupt();
  kind = await Promise.race([running, sleep(8000).then(() => 'timeout' as const)]);
  check('interrupt during a debugged run aborts it', kind === 'ready' && oct.state === 'idle', kind);
  bps.set(script, []); bps.flush();

  // keyboard() enters the debugger too
  kind = await oct.sendLine('kb_var = 1; keyboard');
  check('keyboard enters the debugger', kind === 'debug', `${kind} ${JSON.stringify(out.slice(-200))}`);
  kind = await oct.sendLine('dbquit');
  r = await oct.query('disp(pwd())');
  check('working folder restored after dbquit', fwd(r.out.trim()).toLowerCase() === fwd(os.tmpdir()).toLowerCase(), r.out.trim());

  // stale file: edit + save within the same second, then run again
  fs.writeFileSync(script, 'stale_v = 1;\n');
  await oct.sendLine(`__vsc_run__("${fwd(script)}")`);
  fs.writeFileSync(script, 'stale_v = 2;\n');
  bps.markStale(script);
  bps.flush();
  await oct.sendLine(`__vsc_run__("${fwd(script)}")`);
  r = await oct.query('disp(stale_v)');
  check('saved file is re-read immediately (clear -f)', r.out.trim() === '2', r.out.trim());

  // stop on error, and a hover that errors while stopped there
  await oct.query('dbstop if error');
  fs.writeFileSync(script, 'q = [1 2];\nw = q(3);\n');
  bps.markStale(script); bps.flush();
  kind = await oct.sendLine(`__vsc_run__("${fwd(script)}")`);
  check('dbstop if error stops at the error', kind === 'debug', kind);
  r = await oct.query(`__vsc_vars__('q(5)', "self");`);
  check('failing evaluation does not nest the debugger', r.kind === 'debug' && parseRecords(r.out)[0]?.[0] === 'ERR', JSON.stringify(r));
  kind = await oct.sendLine('dbquit');
  await oct.query('dbclear if error');
  check('quit after error stop', kind === 'ready', kind);

  // program output that looks like the debug prompt
  out = '';
  kind = await oct.sendLine('fprintf("debug> "); pause(0.3); disp("after")');
  check('"debug> " in program output is not a prompt', kind === 'ready' && /debug> after/.test(out), `${kind} ${JSON.stringify(out)}`);
  check('visible prompt events', prompts.includes('debug') && prompts.includes('ready'));

  oct.dispose();
  interrupter.dispose();
  await sleep(500);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
