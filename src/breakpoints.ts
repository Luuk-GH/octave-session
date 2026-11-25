import * as path from 'path';
import { parseRecords } from './helpers';
import { OctaveProcess } from './octaveProcess';

/** Map from requested line to the line Octave actually used (-1 = could not be set). */
export type BreakpointResult = Map<number, number>;

interface FileState {
  file: string;
  lines: number[];
  applied?: string;                       // lines last sent to Octave (JSON), undefined = needs sending
  result?: Promise<BreakpointResult>;     // outcome of the last send
  lineMap?: BreakpointResult;             // ... once known
}

/**
 * Keeps Octave's breakpoints (dbstop) in line with the editor's, independent of any debug session,
 * so Run File, Run Selection and calls typed in the Command Window all stop at them.
 *
 * Octave stores breakpoints in its parsed copy of a file. They are lost when the file is re-parsed
 * (after a save, or `clear all`), and Octave may keep running a stale parse for edits made within the
 * same second. So saved files are marked stale: the next flush drops the cached parse (clear -f)
 * and re-applies that file's breakpoints.
 */
export class BreakpointSync {
  private files = new Map<string, FileState>();
  private stale = new Map<string, string>();  // key -> file

  constructor(private readonly proc: () => OctaveProcess | undefined, private readonly log: (m: string) => void) {}

  /** Set the desired breakpoint lines of a file (1-based). */
  set(file: string, lines: number[]): void {
    const k = key(file);
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    const st = this.files.get(k);
    if (st && JSON.stringify(st.lines) === JSON.stringify(sorted)) { return; }
    if (!sorted.length && !st) { return; }
    this.files.set(k, { file, lines: sorted, result: st?.result, lineMap: st?.lineMap });
  }

  /** The file was saved: drop Octave's cached parse before the next run and re-apply its breakpoints. */
  markStale(file: string): void {
    if (!/\.m$/i.test(file)) { return; }
    this.stale.set(key(file), file);
    const st = this.files.get(key(file));
    if (st) { st.applied = undefined; }
  }

  /** Re-send every file's breakpoints on the next flush (new process, or before Run File). */
  invalidateAll(): void {
    for (const st of this.files.values()) { st.applied = undefined; }
  }

  /** Whether `line` of `file` holds a breakpoint the user set. */
  has(file: string, line: number): boolean {
    const st = this.files.get(key(file));
    if (!st) { return false; }
    return st.lines.includes(line) || [...(st.lineMap ?? new Map()).values()].includes(line);
  }

  /** Outcome of the latest send for a file (after `flush`). */
  result(file: string): Promise<BreakpointResult> | undefined {
    return this.files.get(key(file))?.result;
  }

  /**
   * Queue the pending updates on the Octave process. Queries are enqueued synchronously, so a line
   * sent right after this call runs after them.
   */
  flush(): void {
    const proc = this.proc();
    // 'more': the user is in the middle of a multi-line block; a query now would become part of it.
    if (!proc || proc.state === 'exited' || proc.state === 'starting' || proc.state === 'more') { return; }
    const todo = new Map<string, { file: string; lines: number[]; clear: boolean }>();
    for (const [k, file] of this.stale) { todo.set(k, { file, lines: this.files.get(k)?.lines ?? [], clear: true }); }
    this.stale.clear();
    for (const [k, st] of this.files) {
      const want = JSON.stringify(st.lines);
      if (st.applied === want && !todo.has(k)) { continue; }
      if (!todo.has(k)) { todo.set(k, { file: st.file, lines: st.lines, clear: false }); }
    }
    for (const [k, t] of todo) {
      const st = this.files.get(k);
      const name = path.basename(t.file, path.extname(t.file));
      let result: Promise<BreakpointResult>;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        result = Promise.resolve(new Map(t.lines.map(l => [l, -1])));
        if (t.lines.length) { this.log(`breakpoints: "${path.basename(t.file)}" is not a valid Octave function or script name`); }
      } else {
        const cmd = `__vsc_bp__(${octavePath(t.file)}, [${t.lines.join(' ')}], ${t.clear ? 1 : 0});`;
        result = proc.query(cmd).then(r => {
          // Dropped by an interrupt or exit before it ran: send it again on the next flush.
          if (r.kind === 'cancelled') { const cur = this.files.get(k); if (cur) { cur.applied = undefined; } }
          const map: BreakpointResult = new Map(t.lines.map(l => [l, -1]));
          for (const f of parseRecords(r.out)) {
            if (f[0] === 'BP') { map.set(Number(f[1]), Number(f[2])); }
            else if (f[0] === 'ERR') { this.log(`breakpoints in ${t.file}: ${f[1]}`); }
          }
          if (r.err.trim()) { this.log(`breakpoints in ${t.file}: ${r.err.trim()}`); }
          if (st) { st.lineMap = map; }
          return map;
        });
      }
      if (st) {
        st.applied = JSON.stringify(t.lines);
        st.result = result;
        if (!st.lines.length) { this.files.delete(k); }
      }
    }
  }
}

function key(file: string): string {
  return path.resolve(file).toLowerCase();
}

function octavePath(p: string): string {
  return '"' + p.replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
}
