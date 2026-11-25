import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { CommandQueue, Job } from './commandQueue';
import { ControlRecordFilter } from './controlRecords';
import { Interrupter } from './interrupt';
import { OctaveLaunch } from './locator';

/**
 * One long-lived Octave interpreter on stdio pipes. No VS Code dependency, so it can be smoke-tested in plain Node.
 *
 * Completion detection: Octave's prompts are replaced by sentinel markers (PS1 = READY, PS2 = MORE).
 * Every line written to stdin produces exactly one prompt once Octave wants more input, so a FIFO of
 * pending lines is resolved one marker at a time. Markers are stripped before output is emitted.
 *
 * In the debugger Octave ignores PS1 and prints a fixed "debug> " prompt. It is recognised when it
 * ends the output and nothing else follows within a short settle time.
 *
 * While a command runs, Octave may read a line from stdin itself (input, yes_or_no, pause): the extension's
 * wrappers of those functions print an INPUT control record first, which moves the state to 'input' until
 * `sendInput` answers it. Lines are ordered by a CommandQueue: one in flight at a time.
 */
export const READY_MARK = '\x01OCT_READY\x02';
export const MORE_MARK = '\x01OCT_MORE\x02';
const DEBUG_PROMPT = 'debug> ';

export type OctaveState = 'starting' | 'idle' | 'busy' | 'input' | 'more' | 'debug' | 'exited';
export type PromptKind = 'ready' | 'more' | 'debug' | 'cancelled';
/** `skipped`: a background query that was refused because Octave was not idle (kind is then 'cancelled'). */
export interface QueryResult { kind: PromptKind; out: string; err: string; skipped?: boolean; }

interface Pending extends Job {
  resolve: (kind: PromptKind) => void;
  onSend?: () => void;
  capture?: { out: string; err: string };  // hidden query: output is collected instead of emitted
}

export interface OctaveProcessEvents {
  output: (text: string, stream: 'out' | 'err') => void;
  state: (state: OctaveState) => void;
  /** Octave showed a prompt after a line; `hidden` is true when that line was a query. */
  prompt: (kind: 'ready' | 'more' | 'debug', hidden: boolean) => void;
  /** A running command waits for a line on stdin (`source`: input, yes_or_no or pause). Answer with sendInput. */
  input: (source: string) => void;
  /** edit/open asked for a file to be opened in the editor ("" = a new untitled file). */
  open: (file: string) => void;
  /** clc / home: clear the Command Window. Output before it was already emitted; output after it follows. */
  clear: () => void;
  exit: (code: number | null) => void;
}

/** Delay before acting on a prompt so stderr written just before it (e.g. an error message) is emitted first. */
const STDERR_SETTLE_MS = 30;

export class OctaveProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private _state: OctaveState = 'starting';
  private readonly queue = new CommandQueue<Pending>(p => this.send(p));
  private readonly records = new ControlRecordFilter();  // OPEN / INPUT records in visible output
  private carry = '';           // partial marker / partial "debug> " held back between stdout chunks
  private carryTimer: NodeJS.Timeout | undefined;
  private debugTimer: NodeJS.Timeout | undefined;  // a "debug> " prompt waiting to be confirmed
  private debugSince = 0;       // when that candidate prompt arrived
  private inDebug = false;      // the last prompt was the debugger's
  private stopSeen = false;     // stderr reported "stopped in ..." since the last line was sent
  private initialized = false;  // output before the first READY (initial prompt) is swallowed
  private initResolve!: () => void;
  private initReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(private readonly launch: OctaveLaunch, private readonly interrupter: Interrupter | undefined,
              private readonly log: (msg: string) => void) {
    super();
    this.ready = new Promise((res, rej) => { this.initResolve = res; this.initReject = rej; });
    this.ready.catch(() => { /* surfaced by callers */ });
  }

  override on<E extends keyof OctaveProcessEvents>(event: E, listener: OctaveProcessEvents[E]): this {
    return super.on(event, listener);
  }

  get state(): OctaveState { return this._state; }
  get pid(): number | undefined { return this.proc?.pid; }

  start(cwd: string | undefined): void {
    const args = [...this.launch.args, '--quiet', '--interactive', '--no-line-editing', '--no-history'];
    this.log(`spawn ${this.launch.exe} ${args.join(' ')} (cwd ${cwd ?? process.cwd()}; ${this.launch.note})`);
    // windowsHide: Octave gets its own hidden console, which the interrupt helper attaches to.
    const env = { ...process.env, ...this.launch.env };
    delete env.ELECTRON_RUN_AS_NODE;  // set in the extension host; not meant for child programs
    const proc = spawn(this.launch.exe, args, { cwd, windowsHide: true, stdio: 'pipe', env });
    this.proc = proc;
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    proc.stdout.on('data', (b: Buffer) => this.onStdout(outDec.write(b)));
    proc.stderr.on('data', (b: Buffer) => this.onStderr(errDec.write(b)));
    proc.stdin.on('error', err => this.log(`stdin error: ${err.message}`));
    proc.on('error', err => {
      this.log(`process error: ${err.message}`);
      this.initReject(err);
      this.handleExit(null);
    });
    proc.on('exit', code => this.handleExit(code));

    // Runs after ~/.octaverc, so our prompt settings win. A throwaway figure consumes the SW_HIDE that
    // windowsHide puts in STARTUPINFO; otherwise the user's first figure window would stay invisible.
    const init = [
      `PS1("${READY_MARK}");`, `PS2("${MORE_MARK}");`, 'more off;', 'page_screen_output(false);',
      'try, __vsc_h__ = figure("visible", "on", "position", [-3000 -3000 10 10]); drawnow; close(__vsc_h__); catch, end;',
      'clear __vsc_h__;',
    ].join(' ');
    proc.stdin.write(init + '\n');
  }

  /**
   * Queue one line of input. Resolves with the kind of prompt Octave showed afterwards
   * ('ready' = command finished, 'more' = Octave wants continuation lines, 'debug' = stopped in the debugger,
   * 'cancelled' = dropped by interrupt/exit).
   */
  sendLine(line: string, onSend?: () => void): Promise<PromptKind> {
    if (this._state === 'exited') { return Promise.resolve('cancelled'); }
    const single = line.replace(/\r?\n/g, ' ');
    return new Promise(resolve => {
      this.queue.push({ kind: 'command', line: single, resolve, onSend });
    });
  }

  /**
   * Queue a hidden line: its output is returned instead of shown, and it does not change the visible
   * state (no busy spinner, no prompt redraw) unless it moves Octave in or out of the debugger.
   * A `background` query (completion, help) only runs when Octave is idle at a prompt with nothing queued;
   * otherwise it resolves at once with `skipped`.
   */
  query(line: string, opts: { background?: boolean } = {}): Promise<QueryResult> {
    const skipped: QueryResult = { kind: 'cancelled', out: '', err: '', skipped: true };
    if (this._state === 'exited') { return Promise.resolve({ kind: 'cancelled', out: '', err: '' }); }
    if (opts.background && this._state !== 'idle' && this._state !== 'debug') { return Promise.resolve(skipped); }
    const single = line.replace(/\r?\n/g, ' ');
    const capture = { out: '', err: '' };
    return new Promise(resolve => {
      const accepted = this.queue.push({ kind: opts.background ? 'background' : 'query', line: single, capture,
        resolve: kind => resolve({ kind, ...capture }) });
      if (!accepted) { resolve(skipped); }
    });
  }

  /**
   * Answer a running command that waits for a line on stdin (state 'input'; see the 'input' event). The text is
   * written directly, past the queue. Returns false (and sends nothing) when Octave is not waiting for input.
   */
  sendInput(text: string): boolean {
    if (this._state !== 'input' || !this.proc) { return false; }
    this.setState('busy');
    this.proc.stdin.write(text.replace(/\r?\n/g, ' ') + '\n');
    return true;
  }

  /** Abort the running command (CTRL_BREAK). Pending queued lines are dropped. */
  async interrupt(): Promise<void> {
    if (!this.proc?.pid || this._state === 'exited') { return; }
    for (const p of this.queue.cancelWaiting()) { p.resolve('cancelled'); }
    if (!this.interrupter) { throw new Error('Interrupt is not available.'); }
    const waitingForInput = this._state === 'input';
    await this.interrupter.interrupt(this.proc.pid);
    // A blocked stdin read (input, pause) only sees the interrupt once it returns: give it an empty line.
    if (waitingForInput && this._state === 'input' && this.proc) { this.proc.stdin.write('\n'); }
  }

  get queuedCount(): number { return this.queue.size; }

  dispose(): void {
    if (!this.proc || this._state === 'exited') { return; }
    const proc = this.proc;
    // A running program never reads "exit", and when VS Code is closing the timer below never fires:
    // without this, Octave would be left running in the background.
    if (this._state === 'busy' || this._state === 'input' || this._state === 'starting') { proc.kill(); return; }
    try { proc.stdin.end('exit\n'); } catch { /* ignore */ }
    setTimeout(() => { if (proc.exitCode === null) { proc.kill(); } }, 1500);
  }

  /** Called by the queue when it is this job's turn. */
  private send(next: Pending): void {
    try { next.onSend?.(); } catch (e) { this.log(`onSend failed: ${(e as Error).message}`); }
    if (!next.capture) { this.setState('busy'); }
    this.stopSeen = false;
    this.proc!.stdin.write(next.line + '\n');
  }

  private onStdout(chunk: string): void {
    if (this.carryTimer) { clearTimeout(this.carryTimer); this.carryTimer = undefined; }
    let text = this.carry + chunk;
    this.carry = '';
    if (this.debugTimer) {
      // More output followed "debug> ", so it was program output, not a prompt.
      clearTimeout(this.debugTimer);
      this.debugTimer = undefined;
      text = DEBUG_PROMPT + text;
    }
    // Hold back a trailing partial marker.
    const lastStart = text.lastIndexOf('\x01');
    if (lastStart !== -1 && text.indexOf('\x02', lastStart) === -1 && text.length - lastStart < MORE_MARK.length + 2) {
      this.carry = text.slice(lastStart);
      text = text.slice(0, lastStart);
    }
    const re = /\x01OCT_(READY|MORE)\x02/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      this.emitOut(text.slice(last, m.index), 'out');
      last = m.index + m[0].length;
      this.onPrompt(m[1] === 'READY' ? 'ready' : 'more');
    }
    let rest = text.slice(last);
    if (!this.carry && this.initialized) {
      if (rest.endsWith(DEBUG_PROMPT)) {
        this.emitOut(rest.slice(0, -DEBUG_PROMPT.length), 'out');
        this.debugSince = Date.now();
        this.debugTimer = setTimeout(() => this.confirmDebugPrompt(), STDERR_SETTLE_MS);
        return;
      }
      // A chunk may end in the middle of "debug> ": hold the partial prompt back briefly.
      for (let n = DEBUG_PROMPT.length - 1; n > 0; n--) {
        if (rest.endsWith(DEBUG_PROMPT.slice(0, n))) {
          this.carry = rest.slice(-n);
          rest = rest.slice(0, -n);
          this.carryTimer = setTimeout(() => {
            this.carryTimer = undefined;
            const c = this.carry; this.carry = '';
            this.emitOut(c, 'out');
          }, 100);
          break;
        }
      }
    }
    this.emitOut(rest, 'out');
  }

  /**
   * A trailing "debug> " is accepted as the debugger's prompt at once if Octave is already in the debugger
   * or has just reported a stop on stderr. Otherwise (e.g. `keyboard`, which prints no stop message) only
   * when no further output follows for a while: program output that merely ends in "debug> " usually
   * continues soon. Further output cancels the candidate (see onStdout).
   */
  private confirmDebugPrompt(): void {
    this.debugTimer = undefined;
    if (this.inDebug || this.stopSeen || Date.now() - this.debugSince >= 500) { this.handlePrompt('debug'); return; }
    this.debugTimer = setTimeout(() => this.confirmDebugPrompt(), 50);
  }

  private onStderr(text: string): void {
    if (/(^|\n)stopped in /.test(text)) { this.stopSeen = true; }
    this.emitOut(text, 'err');
  }

  private emitOut(text: string, stream: 'out' | 'err'): void {
    if (!text) { return; }
    if (!this.initialized) {
      this.log(`[startup ${stream}] ${text.trimEnd()}`);
      return;
    }
    const cap = this.queue.current?.capture;
    if (cap) { cap[stream] += text; return; }
    if (stream === 'err') { this.emit('output', text, stream); return; }
    const r = this.records.push(text);
    // Output and records in stream order (a CLEAR must land between the output before and after it).
    let pos = 0;
    for (const rec of r.records) {
      if (rec.at > pos) { this.emit('output', r.text.slice(pos, rec.at), 'out'); pos = rec.at; }
      if (rec.kind === 'OPEN') { this.emit('open', rec.value); }
      else if (rec.kind === 'CLEAR') { this.emit('clear'); }
      else if (this.queue.current && this._state === 'busy') {
        // INPUT: the running command now reads a line from stdin.
        this.setState('input');
        this.emit('input', rec.value);
      }
    }
    if (pos < r.text.length) { this.emit('output', r.text.slice(pos), 'out'); }
  }

  private onPrompt(kind: 'ready' | 'more'): void {
    setTimeout(() => this.handlePrompt(kind), STDERR_SETTLE_MS);
  }

  private handlePrompt(kind: 'ready' | 'more' | 'debug'): void {
    if (this._state === 'exited') { return; }
    if (!this.initialized) {
      if (kind !== 'ready') { return; }
      this.initialized = true;
      this.setState('idle');
      this.initResolve();
      this.queue.prompt();
      return;
    }
    const held = this.queue.current?.capture ? '' : this.records.flush();
    if (held) { this.emit('output', held, 'out'); }
    if (kind !== 'more') { this.inDebug = kind === 'debug'; }
    this.setState(kind === 'ready' ? 'idle' : kind);
    // Finish the current line, tell listeners (queuedCount no longer counts it), then send the next line.
    this.queue.prompt(true, done => {
      done?.resolve(kind);
      this.emit('prompt', kind, !!done?.capture);
    });
  }

  private setState(s: OctaveState): void {
    if (this._state === s) { return; }
    this._state = s;
    this.emit('state', s);
  }

  private handleExit(code: number | null): void {
    if (this._state === 'exited') { return; }
    if (this.debugTimer) { clearTimeout(this.debugTimer); this.debugTimer = undefined; }
    if (this.carryTimer) { clearTimeout(this.carryTimer); this.carryTimer = undefined; }
    this.log(`octave exited (code ${code})`);
    this.setState('exited');
    this.initReject(new Error(`Octave exited during startup (code ${code}).`));
    for (const p of this.queue.cancelAll()) { p.resolve('cancelled'); }
    this.emit('exit', code);
  }
}
