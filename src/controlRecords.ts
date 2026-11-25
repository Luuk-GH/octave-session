// Takes control records out of Octave's visible output. The extension's helper functions print them to ask for
// something:
//   OPEN   edit/open: open this file in the editor
//   INPUT  input/yes_or_no/pause: Octave now waits for a line on stdin
//   CLEAR  clc/home: clear the Command Window (on a pipe, Octave's own clc prints nothing)
// Records look like char(29) KIND char(31) <value> char(30) and may be split across output chunks.
// No VS Code dependency, so it is unit-tested directly.

export type ControlKind = 'OPEN' | 'INPUT' | 'CLEAR';
/** `at`: offset in the returned text where the record was (output before it comes first). */
export interface ControlRecord { kind: ControlKind; value: string; at: number; }

const KINDS: ControlKind[] = ['OPEN', 'INPUT', 'CLEAR'];
const STARTS = KINDS.map(k => `\x1d${k}\x1f`);
const END = '\x1e';

export class ControlRecordFilter {
  private pending = '';

  /** Returns the output with records removed, and the records in the order they appeared. */
  push(chunk: string): { text: string; records: ControlRecord[] } {
    let s = this.pending + chunk;
    this.pending = '';
    const records: ControlRecord[] = [];
    let text = '';
    for (;;) {
      let i = -1, k = -1;
      STARTS.forEach((start, n) => {
        const at = s.indexOf(start);
        if (at !== -1 && (i === -1 || at < i)) { i = at; k = n; }
      });
      if (i === -1) {
        // Keep a trailing partial record start (e.g. "\x1dOP") for the next chunk.
        const keep = partialPrefix(s);
        text += s.slice(0, s.length - keep);
        this.pending = s.slice(s.length - keep);
        break;
      }
      const j = s.indexOf(END, i + STARTS[k].length);
      if (j === -1) {
        text += s.slice(0, i);
        this.pending = s.slice(i);
        break;
      }
      text += s.slice(0, i);
      records.push({ kind: KINDS[k], value: s.slice(i + STARTS[k].length, j), at: text.length });
      s = s.slice(j + 1);
    }
    return { text, records };
  }

  /** Output held back as a possible record start; flush it when the command finishes. */
  flush(): string {
    const p = this.pending;
    this.pending = '';
    return p;
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of one of the record starts. */
function partialPrefix(s: string): number {
  const max = Math.max(...STARTS.map(x => x.length)) - 1;
  for (let n = Math.min(max, s.length); n > 0; n--) {
    const tail = s.slice(-n);
    if (STARTS.some(start => start.length > n && start.startsWith(tail))) { return n; }
  }
  return 0;
}
