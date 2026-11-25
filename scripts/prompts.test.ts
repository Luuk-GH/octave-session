// Prompt detection and the command queue against a real Octave: ready / continuation / debugger prompts,
// input(), yes_or_no and pause() waiting for stdin, background queries refused while busy, interrupt while
// waiting for input. Build + run: npm run test:prompts   (detached from any console, like the extension host)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeHelpers } from '../src/helpers';
import { Interrupter } from '../src/interrupt';
import { resolveOctave } from '../src/locator';
import { OctaveProcess, PromptKind } from '../src/octaveProcess';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const launch = resolveOctave(process.env.OCTAVE_EXE);
  const interrupter = new Interrupter(m => console.log('[log]', m));
  void interrupter.prepare();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octave-prompts-'));
  const helpers = writeHelpers(path.join(tmp, 'helpers'));
  const oct = new OctaveProcess(launch, interrupter, m => console.log('[log]', m));

  let out = '';
  const inputs: string[] = [];
  const prompts: string[] = [];
  oct.on('output', (t, s) => { out += s === 'err' ? `<err>${t}</err>` : t; });
  oct.on('input', src => inputs.push(src));
  oct.on('prompt', (k, hidden) => { if (!hidden) { prompts.push(k); } });
  const reset = () => { out = ''; inputs.length = 0; prompts.length = 0; };
  const waitFor = async (f: () => boolean, ms = 10000) => {
    const end = Date.now() + ms;
    while (!f() && Date.now() < end) { await sleep(20); }
    return f();
  };

  oct.start(tmp);
  await oct.ready;
  const r0 = await oct.query(`warning("off", "Octave:shadowed-function"); addpath("${helpers.replace(/\\/g, '/')}");`);
  check('helpers on the path', r0.kind === 'ready', r0.err);

  // ---- ready / more / debug prompts ----
  reset();
  let k: PromptKind = await oct.sendLine('x = 1;');
  check('ready prompt after a command', k === 'ready' && oct.state === 'idle');
  k = await oct.sendLine('if true');
  check('continuation prompt for an open block', k === 'more' && oct.state === 'more');
  const bg = await oct.query('disp(1)', { background: true });
  check('background query refused at a continuation prompt', !!bg.skipped);
  k = await oct.sendLine('  y = 2;');
  k = await oct.sendLine('end');
  check('block finished', k === 'ready' && oct.state === 'idle');

  reset();
  k = await oct.sendLine('keyboard');
  check('keyboard: debugger prompt', k === 'debug' && oct.state === 'debug', `${k} ${oct.state}`);
  const inDbg = await oct.query('disp(x)', { background: true });
  check('background query runs while stopped in the debugger', inDbg.kind === 'debug' && /1/.test(inDbg.out), JSON.stringify(inDbg));
  k = await oct.sendLine('dbcont');
  check('dbcont leaves the debugger', k === 'ready' && oct.state === 'idle', `${k} ${oct.state}`);

  fs.writeFileSync(path.join(tmp, 'stopme.m'), 'function r = stopme(a)\n  b = a * 2;\n  r = b + 1;\nend\n');
  await oct.sendLine('dbstop stopme 3');
  reset();
  k = await oct.sendLine('v = stopme(4)');
  check('breakpoint: debugger prompt', k === 'debug' && oct.state === 'debug', `${k} ${JSON.stringify(out)}`);
  k = await oct.sendLine('dbcont');
  check('continue to the end', k === 'ready' && /v = 9/.test(out), JSON.stringify(out));
  await oct.sendLine('dbclear all');

  // ---- input() ----
  reset();
  let done = oct.sendLine('n = input("Enter a number: ")');
  check('input(): input request', await waitFor(() => inputs.length > 0) && inputs[0] === 'input' && oct.state === 'input',
    `${inputs} ${oct.state}`);
  check('input(): its prompt is shown, without the control record', await waitFor(() => /Enter a number: $/.test(out))
    && !/[\x1d\x1e\x1f]/.test(out), JSON.stringify(out));
  const busyQ = await oct.query('disp(2)', { background: true });
  check('background query refused while waiting for input', !!busyQ.skipped);
  check('sendInput answers it', oct.sendInput('6*7'));
  k = await done;
  check('input(): value evaluated, back at the prompt', k === 'ready' && /n = 42/.test(out) && oct.state === 'idle', JSON.stringify(out));
  check('sendInput refused when Octave is not waiting', !oct.sendInput('1'));

  reset();
  done = oct.sendLine('s = input("Name? ", "s");');
  await waitFor(() => oct.state === 'input');
  oct.sendInput('Ada Lovelace');
  k = await done;
  const sv = await oct.query('printf("[%s]", s)');
  check('input(..., "s") returns the text', k === 'ready' && sv.out === '[Ada Lovelace]', sv.out);

  // A queued command waits for the running one, including its input request.
  reset();
  done = oct.sendLine('a = input("a? ")');
  const queued = oct.sendLine('b = a + 1');
  await waitFor(() => oct.state === 'input');
  check('queued command is not sent to input()', oct.queuedCount === 2);
  oct.sendInput('10');
  await done;
  k = await queued;
  check('queued command runs afterwards', k === 'ready' && /a = 10/.test(out) && /b = 11/.test(out), JSON.stringify(out));

  // ---- yes_or_no and pause ----
  reset();
  done = oct.sendLine('ok = yes_or_no("Continue? ")');
  check('yes_or_no: input request', await waitFor(() => inputs[0] === 'yes_or_no'), String(inputs));
  oct.sendInput('yes');
  k = await done;
  check('yes_or_no answered', k === 'ready' && /ok = 1/.test(out), JSON.stringify(out));

  reset();
  done = oct.sendLine('disp("before"); pause; disp("after")');
  check('pause(): input request', await waitFor(() => inputs[0] === 'pause') && oct.state === 'input', String(inputs));
  check('pause(): still waiting', !/after/.test(out));
  oct.sendInput('');
  k = await done;
  check('pause(): Enter continues', k === 'ready' && /before\nafter/.test(out), JSON.stringify(out));

  reset();
  k = await oct.sendLine('pause(0.2); disp("timed")');
  check('pause(n) waits without an input request', k === 'ready' && inputs.length === 0 && /timed/.test(out));
  reset();
  k = await oct.sendLine('old = pause("off"); pause; pause(old); disp("skipped")');
  check('pause() does nothing while pause is off', k === 'ready' && inputs.length === 0 && /skipped/.test(out), JSON.stringify(out));

  // ---- background queries vs a running command ----
  reset();
  done = oct.sendLine('pause(1.5); disp("long done")');
  await waitFor(() => oct.state === 'busy');
  const t0 = Date.now();
  const refused = await oct.query('disp(3)', { background: true });
  check('background query refused at once while a command runs', !!refused.skipped && Date.now() - t0 < 100);
  const waited = oct.query('printf("after-long")');   // a normal query queues behind the command
  k = await done;
  const w = await waited;
  check('normal query waits for the command and does not interleave', k === 'ready' && w.out === 'after-long'
    && /long done/.test(out) && !/after-long/.test(out), JSON.stringify({ out, w }));
  const ok = await oct.query('printf("bg")', { background: true });
  check('background query runs when idle', ok.kind === 'ready' && ok.out === 'bg');

  // ---- clc: a CLEAR event between the output before and after it ----
  {
    const seq: string[] = [];
    const onOut = (t: string) => seq.push(`out:${t.trim()}`);
    const onClear = () => seq.push('clear');
    oct.on('output', onOut);
    oct.on('clear', onClear);
    k = await oct.sendLine('disp("old"); clc; disp("new")');
    oct.off('output', onOut);
    oct.off('clear', onClear);
    check('clc: clear event in stream order', k === 'ready' && seq.join('|') === 'out:old|clear|out:new', seq.join('|'));
  }

  // ---- interrupt while waiting for input ----
  reset();
  done = oct.sendLine('z = input("never answered: "); disp("continued")');
  await waitFor(() => oct.state === 'input');
  await oct.interrupt();
  const kk = await Promise.race([done, sleep(5000).then(() => 'timeout' as const)]);
  check('interrupt while waiting for input returns to the prompt', kk === 'ready' && oct.state === 'idle', `${kk} ${oct.state}`);
  const alive = await oct.query('printf("alive %d", exist("z"))');
  check('the command was aborted (nothing after input ran, z not set)', !/continued/.test(out) && alive.out === 'alive 0',
    JSON.stringify({ out, alive }));

  oct.dispose();
  await sleep(1000);
  interrupter.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
