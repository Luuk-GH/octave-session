import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BreakpointSync } from './breakpoints';
import { ConsoleView } from './consoleView';
import { octaveLiteral, parseRecords, writeHelpers } from './helpers';
import { helpFromRecords, HelpInfo } from './language/help';
import { Interrupter } from './interrupt';
import { resolveOctave } from './locator';
import { OctaveProcess, OctaveState, PromptKind, QueryResult } from './octaveProcess';
import { OctaveTerminal } from './terminal';

/** Which Command Window opens by default: the HTML one in the panel, or the raw terminal. */
export type CommandWindowKind = 'webview' | 'terminal';

/** Opens the HTML Command Window (registered by the webview provider). */
export interface CommandWindowReveal { reveal(preserveFocus: boolean): void; }

/**
 * Owns the single shared Octave session: one process, one status bar item, and the Command Window views
 * attached to it (the HTML Command Window and/or the raw terminal). Run commands, both views, the debugger
 * and the MCP server all go through this class, so they share one process and one workspace.
 */
export class SessionManager implements vscode.Disposable {
  private proc: OctaveProcess | undefined;
  private term: OctaveTerminal | undefined;
  private terminal: vscode.Terminal | undefined;
  private terminalOpened: Promise<void> | undefined;
  private terminalOpenedResolve: (() => void) | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly interrupter: Interrupter;
  private readonly tempDir = path.join(os.tmpdir(), `octave-vscode-${process.pid}`);
  private tempCounter = 0;
  private lastTempFile: string | undefined;
  private awaitingRestart = false;
  private disposables: vscode.Disposable[] = [];
  private readonly views = new Set<ConsoleView>();
  private webview: CommandWindowReveal | undefined;
  private uiRevealed = false;
  private helpCache = new Map<string, Promise<HelpInfo | undefined>>();
  private readonly promptEmitter = new vscode.EventEmitter<{ kind: 'ready' | 'more' | 'debug'; hidden: boolean }>();
  private readonly outputEmitter = new vscode.EventEmitter<{ text: string; stream: 'out' | 'err' }>();
  private readonly exitEmitter = new vscode.EventEmitter<void>();
  /** Octave showed a prompt; `hidden` is true after a query. */
  readonly onDidPrompt = this.promptEmitter.event;
  /** Visible output (not query output). */
  readonly onDidOutput = this.outputEmitter.event;
  /** The Octave process exited or was stopped. */
  readonly onDidExit = this.exitEmitter.event;
  /** Editor breakpoints mirrored into Octave. */
  readonly breakpoints = new BreakpointSync(() => this.proc, m => this.log.info(m));

  constructor(context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.interrupter = new Interrupter(m => log.info(m));
    removeStaleHelpers(context.globalStorageUri.fsPath);
    removeStaleTempDirs();
    this.status = vscode.window.createStatusBarItem('octave.session', vscode.StatusBarAlignment.Left, 50);
    this.status.name = 'Octave Session';
    this.updateStatus('stopped');
    // The extension loads in every window (for the MCP server); only show the item where Octave is used.
    const reveal = (d: vscode.TextDocument) => { if (d.languageId === 'octave') { this.revealUi(); } };
    vscode.workspace.textDocuments.forEach(reveal);
    this.disposables.push(this.status, this.promptEmitter, this.outputEmitter, this.exitEmitter,
      vscode.workspace.onDidOpenTextDocument(reveal),
      // A saved function may have a new signature or help text.
      vscode.workspace.onDidSaveTextDocument(d => { if (/\.m$/i.test(d.fileName)) { this.helpCache.clear(); } }),
      vscode.window.onDidCloseTerminal(t => {
        if (t !== this.terminal) { return; }
        const term = this.term;
        this.terminal = undefined;
        this.term = undefined;
        if (term) { this.views.delete(term); }
        // When the terminal is the Command Window, closing it ends the session (as before); when it is only
        // the optional raw view, the session keeps running in the HTML Command Window.
        if (this.viewKind() === 'terminal') { this.stopProcess(); }
      }));
  }

  // ---------- public API ----------

  /** Current state of the Octave process ('exited' when there is none). */
  get state(): OctaveState { return this.proc?.state ?? 'exited'; }

  /** A command is running (possibly waiting for input()): hidden queries would have to wait for it. */
  get running(): boolean { const s = this.state; return s === 'busy' || s === 'input'; }

  /** Show the Command Window (the view chosen in `octave.commandWindow.view`), starting a session if needed. */
  async show(preserveFocus = false): Promise<void> {
    await this.ensureStarted();
    this.reveal(preserveFocus);
  }

  /** Show the raw terminal view of the session (optional when the HTML Command Window is the default). */
  async showTerminal(preserveFocus = false): Promise<void> {
    this.ensureTerminal();
    await this.terminalOpened;
    await this.ensureStarted();
    this.terminal?.show(preserveFocus);
  }

  /** Attach a Command Window view; it receives everything shown from now on. */
  addView(view: ConsoleView): vscode.Disposable {
    this.views.add(view);
    return new vscode.Disposable(() => this.views.delete(view));
  }

  /** Register the HTML Command Window so show/execute can open it. */
  registerCommandWindow(w: CommandWindowReveal): void { this.webview = w; }

  /** The configured default Command Window. */
  viewKind(): CommandWindowKind {
    return vscode.workspace.getConfiguration('octave').get<string>('commandWindow.view') === 'terminal' || !this.webview
      ? 'terminal' : 'webview';
  }

  private reveal(preserveFocus: boolean): void {
    if (this.viewKind() === 'webview') { this.webview?.reveal(preserveFocus); }
    else { this.terminal?.show(preserveFocus); }
  }

  private forViews(fn: (v: ConsoleView) => void, except?: ConsoleView): void {
    for (const v of this.views) {
      if (v === except) { continue; }
      try { fn(v); } catch (e) { this.log.warn(`Command Window view: ${(e as Error).message}`); }
    }
  }

  /**
   * A line or block entered in the HTML Command Window. Depending on what Octave is doing, it answers an
   * input request, continues a statement ('more'), or runs as a command (queued while Octave is busy).
   */
  async submitFromWindow(code: string, origin: ConsoleView): Promise<void> {
    const proc = this.proc;
    if (proc && proc.state === 'input') {
      if (proc.sendInput(code)) { this.forViews(v => v.echoInput(code)); }
      return;
    }
    if (proc && proc.state === 'more') {
      this.forViews(v => v.echoCommand(code));
      void proc.sendLine(code);
      return;
    }
    void origin;
    await this.executeBlock(code, code);
  }

  /** History entries typed in any Command Window view (for the HTML window's history). */
  readonly onDidSubmit = new vscode.EventEmitter<string>();

  /**
   * Run one line of Octave code as if typed (echoed with `display`), after starting the session if needed.
   * Lines are queued while a command is running.
   */
  async execute(line: string, display = line): Promise<PromptKind> {
    const proc = await this.ensureStarted();
    this.reveal(true);
    if (proc.state !== 'idle' || proc.queuedCount > 0) {
      this.log.info(`queued while ${proc.state}: ${display}`);
    }
    this.breakpoints.flush();
    return proc.sendLine(line, () => this.forViews(v => v.echoCommand(display)));
  }

  /** Run a hidden line (not echoed, output returned). Starts the session if needed. */
  async query(line: string): Promise<QueryResult> {
    const proc = await this.ensureStarted();
    return proc.query(line);
  }

  /**
   * Run a script file in the base workspace, as Run File / F5 does. Scripts are called by name from their
   * folder so breakpoints apply; names Octave cannot call fall back to run().
   */
  async runScript(file: string): Promise<PromptKind> {
    const name = path.basename(file, path.extname(file));
    this.breakpoints.markStale(file);
    this.breakpoints.invalidateAll();  // breakpoints may have been dropped by `clear all` etc.
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name) && /\.m$/i.test(file)) {
      return this.execute(`__vsc_run__(${octaveString(file)})`, name);
    }
    return this.execute(`run(${octaveString(file)})`, `run('${path.basename(file)}')`);
  }

  /**
   * What Octave's command line would complete for `prefix`: workspace variables (of the current frame when
   * stopped in the debugger), struct fields, keywords and functions on the path, with their kind.
   * Undefined while Octave is busy or not running (queries would wait behind the running command).
   */
  async completeNames(prefix: string, timeoutMs = 2000): Promise<[string, CompletionKind][] | undefined> {
    const proc = this.proc;
    if (!proc || (proc.state !== 'idle' && proc.state !== 'debug')) { return undefined; }
    const r = await withTimeout(proc.query(`__vsc_complete__(${octaveLiteral(prefix)});`, { background: true }), timeoutMs);
    if (!r || r.kind === 'cancelled') { return undefined; }
    return parseRecords(r.out).filter(f => f.length === 2).map(([k, n]) => [n, k as CompletionKind]);
  }

  /** Usage forms and a short description of a function from Octave's help, cached per Octave process. */
  helpFor(name: string): Promise<HelpInfo | undefined> {
    const hit = this.helpCache.get(name);
    if (hit) { return hit; }
    const proc = this.proc;
    if (!proc || (proc.state !== 'idle' && proc.state !== 'debug')) { return Promise.resolve(undefined); }
    const p = withTimeout(proc.query(`__vsc_sig__(${octaveLiteral(name)});`, { background: true }), 2000).then(r => {
      if (!r || r.kind === 'cancelled') { this.helpCache.delete(name); return undefined; }
      return helpFromRecords(name, parseRecords(r.out));
    });
    this.helpCache.set(name, p);
    return p;
  }

  /**
   * The file that defines function `name` (as `which` reports it), for links in the Command Window.
   * Only asked when Octave is idle; undefined otherwise or when there is no such file.
   */
  async whichFile(name: string): Promise<string | undefined> {
    const proc = this.proc;
    if (!proc || (proc.state !== 'idle' && proc.state !== 'debug')) { return undefined; }
    const r = await withTimeout(proc.query(`printf("%s", which(${octaveLiteral(name)}));`, { background: true }), 2000);
    const f = r && r.kind !== 'cancelled' ? r.out.trim() : '';
    return f && fs.existsSync(f) ? f : undefined;
  }

  /** Lines to print for Tab inside a call in the Command Window: the usage forms and a short description. */
  private async usageLines(name: string): Promise<string[] | undefined> {
    const info = await this.helpFor(name);
    if (!info || (!info.signatures.length && !info.doc)) { return undefined; }
    const lines = info.signatures.slice(0, 8).map(s => s.label);
    if (info.signatures.length > 8) { lines.push(`... ${info.signatures.length - 8} more forms (help ${name})`); }
    if (info.doc) {
      const first = /^.*?[.!?](?=\s|$)/.exec(info.doc)?.[0] ?? info.doc;
      lines.push(first.length > 200 ? first.slice(0, 197) + '...' : first);
    }
    return lines;
  }

  /** Start the session (if needed) without showing the Command Window. */
  /** Recent Command Window text (for tests and diagnostics). */
  terminalText(): string { return this.term?.recentText() ?? ''; }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  /** Run a block of (possibly multi-line) code in the base workspace via a temporary script. */
  async executeBlock(code: string, display: string, forceFile = false): Promise<PromptKind> {
    const trimmed = code.replace(/\s+$/, '');
    if (!trimmed.trim()) { return 'ready'; }
    if (!forceFile && !/\r?\n/.test(trimmed) && !/\.\.\.\s*$/.test(trimmed)) {
      return this.execute(trimmed, display);
    }
    fs.mkdirSync(this.tempDir, { recursive: true });
    // Unique file name per run: Octave caches parsed files by name + timestamp.
    const file = path.join(this.tempDir, `vscode_block_${++this.tempCounter}.m`);
    fs.writeFileSync(file, trimmed + '\n', 'utf8');
    const previous = this.lastTempFile;
    this.lastTempFile = file;
    const result = await this.execute(`source(${octaveString(file)});`, display);
    if (previous) { fs.rm(previous, { force: true }, () => undefined); }
    return result;
  }

  /**
   * Like executeBlock (echoed in the Command Window), but also returns what the run printed. Always runs
   * through a temporary script, so incomplete code is a parse error instead of leaving Octave waiting.
   */
  runBlockCaptured(code: string, display: string, timeoutMs: number): Promise<CapturedRun> {
    return this.capture(() => this.executeBlock(code, display, true), timeoutMs);
  }

  /** Like runScript (breakpoints apply), but also returns what the run printed. */
  runScriptCaptured(file: string, timeoutMs: number): Promise<CapturedRun> {
    return this.capture(() => this.runScript(file), timeoutMs);
  }

  /** Like execute (one echoed line, e.g. `dbstep`), but also returns what it printed. */
  executeCaptured(line: string, timeoutMs: number): Promise<CapturedRun> {
    return this.capture(() => this.execute(line), timeoutMs);
  }

  /**
   * Run `start` (which must send exactly one visible command) and collect its visible output up to the
   * next visible prompt. Hidden queries never reach onDidOutput, so they do not leak in. Only starts when
   * Octave is idle or stopped in the debugger; otherwise resolves 'busy' without running anything.
   * On timeout the run continues; its later output only goes to the Command Window.
   */
  private async capture(start: () => Promise<PromptKind>, timeoutMs: number): Promise<CapturedRun> {
    await this.ensureStarted();
    const state = this.state;
    if (state !== 'idle' && state !== 'debug') { return { kind: 'busy', state, output: '', errorSeen: false }; }
    const run: CapturedRun = { kind: 'timeout', state, output: '', errorSeen: false };
    let errText = '';   // all stderr so far: a chunk may end in the middle of "error: "
    const sub = this.onDidOutput(e => {
      run.output += e.text;
      if (e.stream === 'err') {
        errText += e.text;
        if (/^error: /m.test(errText)) { run.errorSeen = true; }
      }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const started = start();
      started.catch(() => { /* after a timeout nobody else is listening */ });
      const kind = await Promise.race([
        started,
        new Promise<'timeout'>(res => { timer = setTimeout(() => res('timeout'), timeoutMs); }),
      ]);
      run.kind = kind;
      run.state = this.state;
      return run;
    } finally {
      clearTimeout(timer);
      sub.dispose();
    }
  }

  async interrupt(): Promise<void> {
    if (!this.proc || (this.proc.state !== 'busy' && this.proc.state !== 'input')) { return; }
    try {
      await this.proc.interrupt();
    } catch (err) {
      vscode.window.showErrorMessage(`Octave: ${(err as Error).message}`);
    }
  }

  async restart(): Promise<void> {
    if (this.proc && this.proc.state !== 'exited') {
      this.forViews(v => v.info('Restarting Octave…'));
      const old = this.proc;
      const exited = new Promise<void>(res => old.on('exit', () => res()));
      this.stopProcess();
      await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
    }
    await this.ensureStarted();
    this.reveal(true);
  }

  dispose(): void {
    this.stopProcess();
    this.interrupter.dispose();
    this.terminal?.dispose();
    this.disposables.forEach(d => d.dispose());
    this.onDidSubmit.dispose();
    fs.rm(this.tempDir, { recursive: true, force: true }, () => undefined);
  }

  // ---------- internals ----------

  private async ensureStarted(): Promise<OctaveProcess> {
    if (!vscode.workspace.isTrusted) {
      // Running code (and the octave.executable setting of an untrusted folder) needs Workspace Trust.
      const err: ReportedError = new Error('Octave code can only run in a trusted workspace.');
      err.reported = true;
      void vscode.window.showWarningMessage('Octave: running code needs a trusted workspace (Restricted Mode is on).',
        'Manage Workspace Trust').then(c => { if (c) { void vscode.commands.executeCommand('workbench.trust.manage'); } });
      throw err;
    }
    if (this.viewKind() === 'terminal') {
      this.ensureTerminal();
      await this.terminalOpened;
    }
    if (this.proc && this.proc.state !== 'exited') {
      await this.proc.ready;
      return this.proc;
    }
    return this.startProcess();
  }

  private ensureTerminal(): void {
    if (this.terminal && this.term) { return; }
    this.terminalOpened = new Promise(res => { this.terminalOpenedResolve = res; });
    this.term = new OctaveTerminal({
      onOpen: () => this.terminalOpenedResolve?.(),
      onClose: () => { /* handled by onDidCloseTerminal */ },
      onInterrupt: () => { void this.interrupt(); },
      onUserLine: line => this.onUserLine(line),
      onInputLine: line => {
        if (this.proc?.sendInput(line)) { this.forViews(v => v.echoInput(line), this.term); }
      },
      onComplete: async prefix => (await this.completeNames(prefix))?.map(([n]) => n),
      onUsage: name => this.usageLines(name),
    });
    this.terminal = vscode.window.createTerminal({
      name: 'Octave',
      pty: this.term,
      iconPath: new vscode.ThemeIcon('terminal'),
      isTransient: true,
    });
    this.views.add(this.term);
  }

  private onUserLine(line: string): void {
    if (!this.proc || this.proc.state === 'exited') {
      if (this.awaitingRestart) { this.awaitingRestart = false; void this.restart(); }
      return;
    }
    this.breakpoints.flush();
    // The terminal already shows what was typed; the other views get it as an echoed command.
    const term = this.term;
    void this.proc.sendLine(line, () => this.forViews(v => v.echoCommand(line), term));
    if (line.trim()) { this.onDidSubmit.fire(line); }
  }

  private async startProcess(): Promise<OctaveProcess> {
    const cfg = vscode.workspace.getConfiguration('octave');
    let launch;
    try {
      launch = resolveOctave(cfg.get<string>('executable'));
    } catch (err) {
      const msg = (err as Error).message;
      this.forViews(v => v.info(msg));
      this.awaitingRestart = true;
      const actions = process.platform === 'win32' ? ['Download Octave', 'Open Settings'] : ['Open Settings'];
      void vscode.window.showErrorMessage(msg, ...actions).then(choice => {
        if (choice === 'Download Octave') { void vscode.env.openExternal(vscode.Uri.parse('https://octave.org/download')); }
        else if (choice) { void vscode.commands.executeCommand('workbench.action.openSettings', 'octave.executable'); }
      });
      (err as ReportedError).reported = true;
      throw err;
    }
    void this.interrupter.prepare().catch(e => this.log.warn(`interrupt helper unavailable: ${(e as Error).message}`));

    const proc = new OctaveProcess(launch, this.interrupter, m => this.log.info(m));
    this.proc = proc;
    const info = (text: string) => this.forViews(v => v.info(text));
    proc.on('output', (text, stream) => {
      if (this.proc !== proc || !text) { return; }  // late output of a replaced process
      this.forViews(v => v.writeOutput(text, stream));
      this.outputEmitter.fire({ text, stream });
    });
    // edit/open in Octave ask (through a record in the output) for files to open in the editor.
    proc.on('open', file => { if (this.proc === proc) { void this.openInEditor(file); } });
    proc.on('clear', () => { if (this.proc === proc) { this.forViews(v => v.clearScreen()); } });
    proc.on('input', source => {
      if (this.proc !== proc) { return; }
      this.forViews(v => v.requestInput(source));
      this.reveal(true);
    });
    proc.on('state', s => this.onState(proc, s));
    proc.on('prompt', (kind, hidden) => {
      if (this.proc !== proc) { return; }
      // Only show a prompt once nothing else is queued, so queued runs don't leave stray prompts behind.
      if (proc.queuedCount === 0) { this.forViews(v => v.showPrompt(kind)); }
      this.promptEmitter.fire({ kind, hidden });
    });
    proc.on('exit', code => {
      if (this.proc !== proc) { return; }  // replaced: stopProcess already told listeners
      this.helpCache.clear();
      this.exitEmitter.fire();
      this.forViews(v => v.resetInput());
      info(`Octave exited (code ${code}). Press Enter to start a new session.`);
      this.awaitingRestart = true;
    });

    this.updateStatus('starting');
    info(`Starting Octave (${path.basename(launch.exe)})…`);
    proc.start(startFolder());
    // A first start (or an ~/.octaverc loading packages) can be slow; say so instead of looking stuck.
    const slow = setTimeout(() => {
      if (this.proc === proc && proc.state === 'starting') {
        info('Octave is still starting… (the first start after installation can take a while)');
      }
    }, 20000);
    let startTimer: NodeJS.Timeout | undefined;
    try {
      // Without a limit, an Octave that never shows a prompt (a blocking ~/.octaverc, a crash dialog)
      // would leave every command waiting forever.
      await Promise.race([proc.ready, new Promise<never>((_, rej) => {
        startTimer = setTimeout(() => rej(new Error(`Octave did not respond within ${START_TIMEOUT_MS / 1000} s.`)), START_TIMEOUT_MS);
      })]);
    } catch (err) {
      if (this.proc === proc) { this.stopProcess(); }
      this.updateStatus('exited');
      this.awaitingRestart = true;
      void vscode.window.showErrorMessage(
        `Octave could not be started: ${(err as Error).message} See the "Octave Session" output for details.`, 'Show Log')
        .then(c => { if (c) { this.log.show(); } });
      (err as ReportedError).reported = true;
      throw err;
    } finally {
      clearTimeout(slow);
      clearTimeout(startTimer);
    }
    let r: QueryResult;
    try {
      const helpers = writeHelpers(path.join(this.tempDir, 'helpers'));
      r = await proc.query(`__w = warning("off", "Octave:shadowed-function"); addpath(${octaveString(helpers)}); warning(__w); clear __w; disp(OCTAVE_VERSION)`);
      if (r.kind === 'cancelled') { throw new Error('Octave exited while starting.'); }
    } catch (err) {
      // Don't keep a half-initialised Octave (no helper functions): the next command starts a fresh one.
      if (this.proc === proc) { this.stopProcess(); }
      this.updateStatus('exited');
      this.awaitingRestart = true;
      void vscode.window.showErrorMessage(
        `Octave could not be set up: ${(err as Error).message} See the "Octave Session" output for details.`, 'Show Log')
        .then(c => { if (c) { this.log.show(); } });
      (err as ReportedError).reported = true;
      throw err;
    }
    if (/error/i.test(r.err)) { this.log.warn(`adding helper path: ${r.err.trim()}`); }
    const version = r.out.trim();
    this.log.info(`Octave ${version} started (${launch.exe})`);
    if (/^\d/.test(version) && Number(version.split('.')[0]) < 6) {
      void vscode.window.showWarningMessage(`Octave ${version} is older than 6.0; some features (debugger, completion) may not work. Please update Octave.`);
    }
    this.breakpoints.invalidateAll();
    this.breakpoints.flush();
    for (const cmd of cfg.get<string[]>('startupCommands') ?? []) {
      if (cmd.trim()) { await proc.sendLine(cmd, () => this.forViews(v => v.echoCommand(cmd))); }
    }
    return proc;
  }

  private onState(proc: OctaveProcess, s: OctaveState): void {
    if (this.proc !== proc) { return; }
    this.updateStatus(s);
    void vscode.commands.executeCommand('setContext', 'octave.busy', s === 'busy' || s === 'input');
    if (s === 'busy') {
      this.forViews(v => v.setBusy());
    }
  }

  private stopProcess(): void {
    const proc = this.proc;
    this.proc = undefined;
    // Its own exit event is ignored from here on (it is no longer the current process), so tell listeners now.
    if (proc && proc.state !== 'exited') { this.exitEmitter.fire(); this.forViews(v => v.resetInput()); }
    proc?.dispose();
    this.updateStatus('stopped');
    void vscode.commands.executeCommand('setContext', 'octave.busy', false);
  }

  /** Show the status bar item and the Octave view container (hidden in windows that never use Octave). */
  private revealUi(): void {
    if (this.uiRevealed) { return; }
    this.uiRevealed = true;
    this.status.show();
    void vscode.commands.executeCommand('setContext', 'octave.used', true);
  }

  /** Open a file asked for by edit/open in Octave ("" = a new untitled Octave file). */
  private async openInEditor(file: string): Promise<void> {
    try {
      const doc = file
        ? await vscode.workspace.openTextDocument(vscode.Uri.file(file))
        : await vscode.workspace.openTextDocument({ language: 'octave' });
      await vscode.window.showTextDocument(doc, { preview: false });
      this.log.info(`opened from Octave: ${file || '(untitled)'}`);
    } catch (err) {
      this.log.warn(`could not open ${file}: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(`Octave: could not open ${file}: ${(err as Error).message}`);
    }
  }

  private updateStatus(s: OctaveState | 'stopped'): void {
    const map: Record<string, [string, string, string | undefined]> = {
      stopped:  ['$(circle-outline) Octave', 'Octave: no session. Click to start.', 'octave.showTerminal'],
      starting: ['$(loading~spin) Octave', 'Octave: starting…', 'octave.showTerminal'],
      idle:     ['$(circle-filled) Octave', 'Octave: idle. Click to show the Command Window.', 'octave.showTerminal'],
      more:     ['$(circle-filled) Octave', 'Octave: waiting for continuation input.', 'octave.showTerminal'],
      debug:    ['$(debug-pause) Octave', 'Octave: paused in the debugger. Click to show the Command Window.', 'octave.showTerminal'],
      busy:     ['$(sync~spin) Octave', 'Octave: busy. Click to interrupt.', 'octave.interrupt'],
      input:    ['$(keyboard) Octave', 'Octave: waiting for input in the Command Window.', 'octave.showTerminal'],
      exited:   ['$(error) Octave', 'Octave: exited. Click to show the Command Window.', 'octave.showTerminal'],
    };
    if (s !== 'stopped') { this.revealUi(); }
    const [text, tooltip, command] = map[s];
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.command = command;
  }
}

/** Earlier versions compiled an interrupt helper .exe into global storage (blocked by Smart App Control). */
function removeStaleHelpers(dir: string): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^octave-break-v\d+\.(exe|cs)$/.test(f)) { fs.rmSync(path.join(dir, f), { force: true }); }
    }
  } catch { /* directory may not exist */ }
}

/** Quote a path as an Octave double-quoted string. Forward slashes avoid backslash escapes. */
/** An error the session already showed to the user (command wrappers don't show it again). */
export interface ReportedError extends Error { reported?: boolean; }

/**
 * Folder Octave starts in: the first workspace folder, else the active file's folder, else the home folder
 * (not the VS Code installation folder, which is the extension host's working directory).
 */
function startFolder(): string {
  const ws = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file');
  if (ws) { return ws.uri.fsPath; }
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') { return path.dirname(doc.uri.fsPath); }
  return os.homedir();
}

/** Remove temp folders of earlier VS Code windows that are gone (e.g. after a crash). */
function removeStaleTempDirs(): void {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const m = /^octave-vscode-(\d+)$/.exec(name);
      if (!m || Number(m[1]) === process.pid || processAlive(Number(m[1]))) { continue; }
      fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true }, () => undefined);
    }
  } catch { /* temp folder not readable */ }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const START_TIMEOUT_MS = 120000;

/** Outcome of a captured run: how it ended, the visible output (raw, may contain ANSI), and whether Octave printed an error. */
export interface CapturedRun {
  kind: PromptKind | 'timeout' | 'busy';
  /** Session state when the run ended (or, for 'busy', when it was refused). */
  state: OctaveState;
  output: string;
  errorSeen: boolean;
}

/** Kind of a completion candidate: v = variable, f = struct field, k = keyword, F = function or other name. */
export type CompletionKind = 'v' | 'f' | 'k' | 'F';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

export function octaveString(p: string): string {
  return '"' + p.replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
}
