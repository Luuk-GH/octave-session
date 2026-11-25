// Unit checks for taking control records (OPEN, INPUT, CLEAR) out of Octave's output. Run: npm run test:unit
import * as assert from 'assert';
import { ControlRecordFilter } from '../src/controlRecords';

const R = (p: string) => `\x1dOPEN\x1f${p}\x1e`;
const I = (p: string) => `\x1dINPUT\x1f${p}\x1e`;
const C = '\x1dCLEAR\x1f\x1e';
const rec = (kind: string, value: string, at: number) => ({ kind, value, at });

// Plain output passes through.
let f = new ControlRecordFilter();
assert.deepStrictEqual(f.push('x = 1\n'), { text: 'x = 1\n', records: [] });

// A record in the middle, and two records in one chunk; `at` is the record's place in the returned text.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push(`before${R('C:\\a\\b.m')}after`), { text: 'beforeafter', records: [rec('OPEN', 'C:\\a\\b.m', 6)] });
assert.deepStrictEqual(f.push(`${R('')}Created x.m\n${R('C:/x.m')}`),
  { text: 'Created x.m\n', records: [rec('OPEN', '', 0), rec('OPEN', 'C:/x.m', 12)] });

// A record split across chunks, including inside the start marker.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push('out\x1dOP'), { text: 'out', records: [] });
assert.deepStrictEqual(f.push('EN\x1fC:/dir/fi'), { text: '', records: [] });
assert.deepStrictEqual(f.push('le.m\x1erest'), { text: 'rest', records: [rec('OPEN', 'C:/dir/file.m', 0)] });

// Other record types (helper output) and lone separators are left alone.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push('\x1dBP\x1f3\x1f3\x1e'), { text: '\x1dBP\x1f3\x1f3\x1e', records: [] });

// A held-back partial start that turns out not to be a record is released on the next chunk or on flush.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push('a\x1d'), { text: 'a', records: [] });
assert.deepStrictEqual(f.push('xyz'), { text: '\x1dxyz', records: [] });
assert.deepStrictEqual(f.push('b\x1dOPEN'), { text: 'b', records: [] });
assert.strictEqual(f.flush(), '\x1dOPEN');
assert.strictEqual(f.flush(), '');

// INPUT records (input / yes_or_no / pause waiting for stdin), mixed with OPEN, in stream order.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push(`${I('input')}Enter a number: `), { text: 'Enter a number: ', records: [rec('INPUT', 'input', 0)] });
assert.deepStrictEqual(f.push('x\x1dIN'), { text: 'x', records: [] });
assert.deepStrictEqual(f.push(`PUT\x1fpause\x1e${R('C:/a.m')}`),
  { text: '', records: [rec('INPUT', 'pause', 0), rec('OPEN', 'C:/a.m', 0)] });
// "\x1dI" could start INPUT, "\x1dINX" cannot.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push('q\x1dI'), { text: 'q', records: [] });
assert.deepStrictEqual(f.push('NX'), { text: '\x1dINX', records: [] });

// CLEAR (clc): its position separates the output before it from the output after it.
f = new ControlRecordFilter();
assert.deepStrictEqual(f.push(`old\n${C}new\n`), { text: 'old\nnew\n', records: [rec('CLEAR', '', 4)] });
assert.deepStrictEqual(f.push('\x1dCL'), { text: '', records: [] });
assert.deepStrictEqual(f.push('EAR\x1f\x1e!'), { text: '!', records: [rec('CLEAR', '', 0)] });

console.log('controlRecords: all assertions passed');
