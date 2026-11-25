// Unit checks for the command queue: one line in flight, FIFO order, background queries refused while busy.
// Run: npm run test:unit
import * as assert from 'assert';
import { CommandQueue, Job } from '../src/commandQueue';

interface J extends Job { id: string; }
const job = (id: string, kind: Job['kind'] = 'command'): J => ({ id, kind, line: id });

function make(): { q: CommandQueue<J>; sent: string[] } {
  const sent: string[] = [];
  const q = new CommandQueue<J>(j => sent.push(j.id));
  return { q, sent };
}

// Nothing is sent before the interpreter's first prompt; then lines go out one at a time.
{
  const { q, sent } = make();
  q.push(job('a'));
  q.push(job('b', 'query'));
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(q.size, 2);
  assert.strictEqual(q.prompt(), undefined);          // first prompt: finishes nothing, sends a
  assert.deepStrictEqual(sent, ['a']);
  assert.strictEqual(q.current?.id, 'a');
  assert.strictEqual(q.prompt()?.id, 'a');            // a done, b sent
  assert.deepStrictEqual(sent, ['a', 'b']);
  assert.strictEqual(q.prompt()?.id, 'b');
  assert.strictEqual(q.size, 0);
  assert.strictEqual(q.idle, true);
}

// Commands and queries keep FIFO order; a line is never sent while another is in flight.
{
  const { q, sent } = make();
  q.prompt();
  q.push(job('run'));
  q.push(job('vars', 'query'));
  q.push(job('next'));
  assert.deepStrictEqual(sent, ['run']);
  q.push(job('more', 'query'));
  assert.deepStrictEqual(sent, ['run']);              // still waiting for run's prompt
  q.prompt(); q.prompt(); q.prompt();
  assert.deepStrictEqual(sent, ['run', 'vars', 'next', 'more']);
}

// Background jobs run only when the interpreter is idle; while busy they are refused, not queued.
{
  const { q, sent } = make();
  assert.strictEqual(q.push(job('early', 'background')), false);   // before the first prompt
  q.prompt();
  assert.strictEqual(q.push(job('complete', 'background')), true); // idle: runs at once
  assert.deepStrictEqual(sent, ['complete']);
  assert.strictEqual(q.push(job('help', 'background')), true);     // waits behind another hidden query
  assert.deepStrictEqual(sent, ['complete']);
  q.prompt();
  assert.deepStrictEqual(sent, ['complete', 'help']);
  q.prompt();
  q.push(job('long'));
  assert.strictEqual(q.push(job('complete2', 'background')), false); // a command is running
  assert.deepStrictEqual(sent, ['complete', 'help', 'long']);
  // A command queued behind an in-flight background query waits for it (no interleaving).
  q.prompt();
  q.push(job('bg', 'background'));
  q.push(job('user'));
  assert.deepStrictEqual(sent, ['complete', 'help', 'long', 'bg']);
  assert.strictEqual(q.push(job('bg2', 'background')), false);     // a command is queued
  q.prompt();
  assert.deepStrictEqual(sent, ['complete', 'help', 'long', 'bg', 'user']);
  // Behind a queued hidden query (e.g. the Workspace view refreshing), a background query is accepted.
  q.prompt();
  q.push(job('vars', 'query'));
  assert.strictEqual(q.push(job('bg3', 'background')), true);
  q.prompt(); q.prompt();
  assert.deepStrictEqual(sent.slice(-2), ['vars', 'bg3']);
}

// Interrupt: queued jobs are dropped, the running one stays until its prompt.
{
  const { q, sent } = make();
  q.prompt();
  q.push(job('loop')); q.push(job('x')); q.push(job('y', 'query'));
  const dropped = q.cancelWaiting();
  assert.deepStrictEqual(dropped.map(j => j.id), ['x', 'y']);
  assert.strictEqual(q.current?.id, 'loop');
  assert.strictEqual(q.prompt()?.id, 'loop');
  assert.deepStrictEqual(sent, ['loop']);
  assert.strictEqual(q.idle, true);
}

// Exit: everything is dropped, current first, and nothing is sent afterwards.
{
  const { q, sent } = make();
  q.prompt();
  q.push(job('a')); q.push(job('b'));
  assert.deepStrictEqual(q.cancelAll().map(j => j.id), ['a', 'b']);
  q.push(job('c'));
  assert.deepStrictEqual(sent, ['a']);
  assert.strictEqual(q.idle, false);
  assert.strictEqual(q.push(job('d', 'background')), false);
}

// A prompt that does not take input (open = false) holds the queue until the next open prompt.
{
  const { q, sent } = make();
  q.prompt();
  q.push(job('a')); q.push(job('b'));
  q.prompt(false);
  assert.deepStrictEqual(sent, ['a']);
  q.prompt(true);
  assert.deepStrictEqual(sent, ['a', 'b']);
}

// beforeNext runs after the finished job left the queue and before the next one is sent.
{
  const { q, sent } = make();
  q.prompt();
  q.push(job('a')); q.push(job('b'));
  let seen = '';
  q.prompt(true, done => { seen = `${done?.id} size=${q.size} sent=${sent.join(',')}`; });
  assert.strictEqual(seen, 'a size=1 sent=a');
  assert.deepStrictEqual(sent, ['a', 'b']);
}

console.log('commandQueue: all assertions passed');
