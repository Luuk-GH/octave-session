import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { octaveLiteral, parseRecords } from './helpers';
import { SessionManager } from './session';

/**
 * Inline Debug Adapter (DAP) on top of the shared Octave session.
 *
 * Nothing is spawned: the program runs in the same Octave process as the Command Window.
 * - Breakpoints are mirrored by BreakpointSync (dbstop), also outside debug sessions.
 * - Continue / step map to dbcont / dbstep [in|out], echoed in the Command Window like typed commands.
 * - Stack, variables and hovers use hidden queries with the __vsc_*__ helpers; frames are selected with dbup/dbdown.
 * - The session ends when Octave returns to the top-level prompt.
 */

interface Request { seq: number; type: 'request'; command: string; arguments?: any; }
interface Frame { id: number; file: string; name: string; line: number; column: number; }
interface VarRef { frame: number; expr: string; }

const THREAD_ID = 1;

export class OctaveDebugAdapter implements vscode.DebugAdapter {
  private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sendEmitter.event;
  private seq = 1;
  private configDone!: () => void;
  private readonly configured = new Promise<void>(r => { this.configDone = r; });
  private readonly disposables: vscode.Disposable[] = [];

  private frames: Promise<Frame[]> | undefined;   // stack of the current stop
  private selectedFrame = 1;                      // Octave's current frame (1 = innermost)
  private refs = new Map<number, VarRef>();
  private childExprs = new Map<number, Map<string, string>>();
  private nextRef = 1;
  private lastAction: 'step' | undefined;
  private errorSeen = false;
  private active = false;      // a program runs or is stopped under this session; the top-level prompt ends it
  private terminated = false;
  private supportsInvalidated = false;

  constructor(private readonly session: SessionManager, private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      session.onDidPrompt(e => this.onPrompt(e.kind, e.hidden)),
      session.onDidOutput(e => { if (e.stream === 'err' && /^error: /m.test(e.text)) { this.errorSeen = true; } }),
      session.onDidExit(() => this.terminate()),
    );
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const req = message as Request;
    if (req.type !== 'request') { return; }
    this.dispatch(req).catch(err => this.respond(req, undefined, (err as Error).message ?? String(err)));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.sendEmitter.dispose();
  }

  // ---------- requests ----------

  private async dispatch(req: Request): Promise<void> {
    const a = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        this.supportsInvalidated = !!a.supportsInvalidatedEvent;
        this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: true,
          supportsTerminateRequest: true,
          supportTerminateDebuggee: true,
          exceptionBreakpointFilters: [
            { filter: 'error', label: 'Errors', description: 'Pause when an error occurs (dbstop if error)', default: false },
          ],
        });
        this.event('initialized');
        return;

      case 'launch': return this.launch(req, a);
      case 'attach': return this.attach(req);

      case 'configurationDone':
        this.respond(req);
        this.configDone();
        return;

      case 'setBreakpoints': return this.setBreakpoints(req, a);

      case 'setExceptionBreakpoints': {
        const on = (a.filters ?? []).includes('error');
        if (this.session.state !== 'exited') { void this.session.query(on ? 'dbstop if error' : 'dbclear if error'); }
        this.respond(req);
        return;
      }

      case 'threads':
        this.respond(req, { threads: [{ id: THREAD_ID, name: 'Octave' }] });
        return;

      case 'stackTrace': return this.stackTrace(req, a);

      case 'scopes':
        this.respond(req, {
          scopes: [{ name: 'Locals', presentationHint: 'locals', expensive: false,
                     variablesReference: this.ref({ frame: a.frameId ?? 1, expr: '' }) }],
        });
        return;

      case 'variables': return this.variables(req, a);
      case 'evaluate': return this.evaluate(req, a);
      case 'setVariable': return this.setVariable(req, a);

      case 'continue': this.resume(req, 'dbcont', undefined, { allThreadsContinued: true }); return;
      case 'next': this.resume(req, 'dbstep', 'step'); return;
      case 'stepIn': this.resume(req, 'dbstep in', 'step'); return;
      case 'stepOut': this.resume(req, 'dbstep out', 'step'); return;

      case 'pause':
        // On Windows Octave can only be interrupted with CTRL_BREAK, which aborts the command instead of
        // entering the debugger (debug_on_interrupt only applies to SIGINT).
        this.respond(req, undefined,
          'Octave on Windows cannot pause a running program. Set a breakpoint, or use Stop (or Ctrl+C in the Command Window) to abort it.');
        return;

      case 'disconnect':
      case 'terminate':
        await this.stopProgram();
        this.respond(req);
        this.terminate();
        return;

      default:
        this.respond(req, undefined, `Unsupported request: ${req.command}`);
    }
  }

  private async launch(req: Request, a: { program?: string }): Promise<void> {
    const program = a.program || vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!program || !fs.existsSync(program)) {
      throw new Error(program ? `File not found: ${program}` : 'No file to run. Open an Octave script first.');
    }
    if (this.session.state === 'debug') {
      throw new Error('Octave is already paused in the debugger. Continue or stop that first.');
    }
    await this.session.show(true);
    this.respond(req);
    await this.configured;
    this.active = true;
    void this.session.runScript(program);
  }

  private async attach(req: Request): Promise<void> {
    await this.session.start();
    this.respond(req);
    await this.configured;
    const s = this.session.state;
    if (s === 'debug') {
      this.active = true;
      await this.stopped();
    } else if (s === 'busy' || s === 'input') {
      this.active = true;
    }
  }

  private async setBreakpoints(req: Request, a: any): Promise<void> {
    const file: string | undefined = a.source?.path;
    const lines: number[] = (a.breakpoints ?? []).map((b: { line: number }) => b.line);
    if (!file) { this.respond(req, { breakpoints: lines.map(l => ({ verified: false, line: l })) }); return; }
    const bps = this.session.breakpoints;
    bps.set(file, lines);
    bps.flush();
    let result: Map<number, number> | undefined;
    const pending = bps.result(file);
    // While a program runs, Octave can't take commands: the breakpoints are applied at its next prompt.
    if (pending && !this.session.running) {
      result = await Promise.race([pending, new Promise<undefined>(r => setTimeout(() => r(undefined), 3000))]);
    }
    this.respond(req, {
      breakpoints: lines.map(l => {
        const actual = result?.get(l);
        if (actual === undefined) { return { verified: true, line: l }; }
        return actual > 0
          ? { verified: true, line: actual }
          : { verified: false, line: l, message: 'Octave could not set a breakpoint here (no code on this line, or the file name is not a valid Octave name).' };
      }),
    });
  }

  private async stackTrace(req: Request, a: { startFrame?: number; levels?: number }): Promise<void> {
    const all = (await this.getFrames()).filter(f => !f.name.startsWith('__vsc_'));
    const start = a.startFrame ?? 0;
    const shown = a.levels ? all.slice(start, start + a.levels) : all.slice(start);
    this.respond(req, {
      totalFrames: all.length,
      stackFrames: shown.map(f => {
        const internal = /[\\/]share[\\/]octave[\\/]/i.test(f.file);
        return {
          id: f.id, name: f.name, line: f.line, column: Math.max(1, f.column),
          source: f.file ? { name: path.basename(f.file), path: f.file, presentationHint: internal ? 'deemphasize' : undefined } : undefined,
          presentationHint: internal ? 'subtle' : undefined,
        };
      }),
    });
  }

  private async variables(req: Request, a: { variablesReference: number }): Promise<void> {
    const vr = this.refs.get(a.variablesReference);
    if (!vr) { this.respond(req, { variables: [] }); return; }
    const r = await this.query(vr.frame, `__vsc_vars__(${octaveLiteral(vr.expr)});`);
    const names = new Map<string, string>();
    const variables = parseRecords(r.out).filter(f => f.length >= 5 && f[0] !== 'ERR').map(([name, value, type, expr, kids]) => {
      const label = name || expr;
      names.set(label, expr);
      return {
        name: label, value, type, evaluateName: expr,
        variablesReference: Number(kids) > 0 ? this.ref({ frame: vr.frame, expr }) : 0,
      };
    });
    this.childExprs.set(a.variablesReference, names);
    this.respond(req, { variables });
  }

  private async evaluate(req: Request, a: { expression: string; frameId?: number; context?: string }): Promise<void> {
    const frame = a.frameId ?? this.selectedFrame;
    const expr = a.expression.trim();
    if (a.context === 'repl') {
      // Through eval, incomplete input ("if x") is a parse error instead of leaving Octave waiting for
      // continuation lines, which would swallow every later hidden query. Debugger commands go as typed.
      const r = await this.query(frame, /^\s*db\w+\b/.test(expr) ? expr : `eval(${octaveLiteral(expr)})`);
      const text = (r.out + r.err).replace(/\s+$/, '');
      this.respond(req, { result: text, variablesReference: 0 });
      if (r.kind === 'ready' && this.active) { this.terminate(); }
      else if (r.kind === 'debug' && /^\s*db(step|cont|up|down)\b/.test(expr)) { void this.stopped('step'); }
      else if (this.supportsInvalidated) { this.event('invalidated', { areas: ['variables'] }); }
      return;
    }
    const mode = a.context === 'hover' ? 'hover' : 'self';
    const r = await this.query(frame, `__vsc_vars__(${octaveLiteral(expr)}, "${mode}");`);
    const rec = parseRecords(r.out).find(f => f.length >= 5);
    if (!rec) {
      const err = parseRecords(r.out).find(f => f[0] === 'ERR')?.[1] ?? /error: (.*)/.exec(r.err)?.[1];
      throw new Error(err ?? 'not available');
    }
    const [, value, type, childExpr, kids] = rec;
    this.respond(req, {
      result: value, type,
      variablesReference: Number(kids) > 0 ? this.ref({ frame, expr: childExpr }) : 0,
    });
  }

  private async setVariable(req: Request, a: { variablesReference: number; name: string; value: string }): Promise<void> {
    const vr = this.refs.get(a.variablesReference);
    if (!vr) { throw new Error('Variable is no longer available.'); }
    const target = this.childExprs.get(a.variablesReference)?.get(a.name) ?? a.name;
    const r = await this.query(vr.frame, `eval(${octaveLiteral(`${target} = ${a.value};`)}); __vsc_vars__(${octaveLiteral(target)}, "self");`);
    const err = /error: (.*)/.exec(r.err)?.[1];
    if (err) { throw new Error(err); }
    const rec = parseRecords(r.out).find(f => f.length >= 5);
    if (!rec) { throw new Error('Could not read the new value.'); }
    const [, value, type, childExpr, kids] = rec;
    this.respond(req, { value, type, variablesReference: Number(kids) > 0 ? this.ref({ frame: vr.frame, expr: childExpr }) : 0 });
  }

  private resume(req: Request, cmd: string, action: 'step' | undefined, body?: object): void {
    if (this.session.state !== 'debug') {
      this.respond(req, body);
      return;
    }
    this.lastAction = action;
    this.errorSeen = false;
    this.invalidate();
    this.respond(req, body);
    void this.session.execute(cmd);
  }

  // ---------- Octave events ----------

  private onPrompt(kind: 'ready' | 'more' | 'debug', hidden: boolean): void {
    if (hidden || this.terminated) { return; }
    if (kind === 'debug') {
      this.active = true;
      void this.stopped();
    } else if (kind === 'ready' && this.active) {
      this.terminate();
    }
  }

  private async stopped(reason?: string): Promise<void> {
    await this.configured;
    if (this.terminated) { return; }
    this.invalidate();
    this.selectedFrame = 1;  // Octave selects the innermost frame at each stop
    let top: Frame | undefined;
    try {
      const frames = await this.getFrames();
      if (frames[0]?.name.startsWith('__vsc_')) {
        // Stepped past the end of the script into the Run File helper: nothing of the user's is left to debug.
        const r = await this.session.query('dbcont');
        if (r.kind === 'debug') { return this.stopped(reason); }
        if (r.kind === 'ready') { this.terminate(); }
        return;
      }
      top = frames.find(f => !f.name.startsWith('__vsc_'));
    } catch (err) {
      this.log.warn(`reading the call stack failed: ${(err as Error).message}`);
    }
    if (!reason) {
      if (top && this.session.breakpoints.has(top.file, top.line)) { reason = 'breakpoint'; }
      else if (this.errorSeen) { reason = 'exception'; }
      else { reason = this.lastAction ?? 'step'; }
    }
    this.lastAction = undefined;
    this.errorSeen = false;
    const body: Record<string, unknown> = { reason, threadId: THREAD_ID, allThreadsStopped: true };
    if (reason === 'exception') { body.description = 'Paused on error'; }
    this.event('stopped', body);
  }

  private getFrames(): Promise<Frame[]> {
    if (!this.frames) {
      this.frames = this.session.query('__vsc_stack__();').then(r => {
        const frames: Frame[] = [];
        for (const f of parseRecords(r.out)) {
          if (f[0] === 'F') {
            frames.push({ id: frames.length + 1, file: f[1], name: f[2], line: Number(f[3]), column: Number(f[4]) });
          }
        }
        if (!frames.length && r.err.trim()) { throw new Error(r.err.trim()); }
        return frames;
      });
    }
    return this.frames;
  }

  // ---------- helpers ----------

  /** Run a hidden query in the given frame (selected with dbup/dbdown first). */
  private query(frame: number, line: string) {
    // A hidden line would wait behind the running program (forever, for an endless loop).
    if (this.session.running) { return Promise.reject(new Error('Octave is running.')); }
    if (this.session.state === 'debug') {
      // A frame change only takes effect after its own line, so it is sent separately (queued in order).
      const delta = frame - this.selectedFrame;
      if (delta > 0) { void this.session.query(`dbup(${delta})`); } else if (delta < 0) { void this.session.query(`dbdown(${-delta})`); }
      this.selectedFrame = frame;
    }
    return this.session.query(line);
  }

  private invalidate(): void {
    this.frames = undefined;
    this.refs.clear();
    this.childExprs.clear();
  }

  private ref(v: VarRef): number {
    const id = this.nextRef++;
    this.refs.set(id, v);
    return id;
  }

  private async stopProgram(): Promise<void> {
    if (this.terminated) { return; }
    if (this.session.running) {
      const prompt = new Promise<void>(res => {
        const d = this.session.onDidPrompt(() => { d.dispose(); res(); });
        setTimeout(() => { d.dispose(); res(); }, 3000);
      });
      await this.session.interrupt();
      await prompt;
    }
    if (this.session.state === 'debug') {
      await this.session.execute('dbquit');
    }
  }

  private terminate(): void {
    if (this.terminated) { return; }
    this.terminated = true;
    this.active = false;
    this.event('terminated');
  }

  private respond(req: Request, body?: unknown, error?: string): void {
    this.send({
      type: 'response', request_seq: req.seq, command: req.command, success: !error,
      ...(error ? { message: error } : {}), ...(body !== undefined ? { body } : {}),
    });
  }

  private event(event: string, body?: unknown): void {
    this.send({ type: 'event', event, ...(body !== undefined ? { body } : {}) });
  }

  private send(msg: Record<string, unknown>): void {
    this.sendEmitter.fire({ seq: this.seq++, ...msg } as vscode.DebugProtocolMessage);
  }
}
