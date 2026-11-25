// VS Code side of the MCP server: settings, token, lifecycle, commands and the Octave tools.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { octaveLiteral, parseRecords } from '../helpers';
import { CapturedRun, SessionManager } from '../session';
import { cleanOutput, handleText, McpBackend, textResult, ToolDef, ToolResult, truncateText } from './protocol';
import { RunningMcpServer, startMcpServer } from './server';
import { SERVER_INSTRUCTIONS, TOOLS } from './tools';

const TOKEN_KEY = 'octave.mcp.token';
const DEFAULT_PORT = 39217;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the extension API exposes (for tests and the setup command). */
export interface McpHandle {
  /** Port the server listens on, undefined while it is not running. */
  readonly port: number | undefined;
  readonly token: string | undefined;
}

export function registerMcp(context: vscode.ExtensionContext, session: SessionManager, log: vscode.LogOutputChannel): McpHandle {
  const backend = new OctaveTools(session);
  const info = { name: 'octave-session', version: String(context.extension.packageJSON.version), instructions: SERVER_INSTRUCTIONS };
  let server: RunningMcpServer | undefined;
  let serverPortSetting = 0;
  let token: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const loadToken = async (): Promise<string> => {
    let t = await context.secrets.get(TOKEN_KEY);
    if (!t) {
      t = crypto.randomBytes(32).toString('hex');
      await context.secrets.store(TOKEN_KEY, t);
    }
    return t;
  };

  const stop = async () => {
    const s = server;
    server = undefined;
    if (s) { await s.close(); log.info('MCP server stopped'); }
  };

  const reconcileNow = async (restart: boolean) => {
    const cfg = vscode.workspace.getConfiguration('octave.mcp');
    const want = !disposed && cfg.get<boolean>('enabled', false) && vscode.workspace.isTrusted;
    const port = cfg.get<number>('port', DEFAULT_PORT);
    if (server && (!want || restart || port !== serverPortSetting)) { await stop(); }
    if (!want || server) { return; }
    token ??= await loadToken();
    try {
      server = await startMcpServer({
        token, port, log: m => log.info(m),
        handle: text => handleText(text, backend, info),
      });
      serverPortSetting = port;
    } catch (e) {
      log.error((e as Error).message);
      void vscode.window.showErrorMessage(`Octave MCP server: ${(e as Error).message}`);
    }
  };
  const reconcile = (restart = false): Promise<void> =>
    (chain = chain.then(() => reconcileNow(restart)).catch(e => log.error(`MCP: ${(e as Error).stack ?? e}`)));

  const handle: McpHandle = {
    get port() { return server?.port; },
    // Only the test runs read the token through the extension API; other extensions don't get it.
    get token() { return server && process.env.OCTAVE_IT_RESULT ? token : undefined; },
  };

  const command = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await fn(); } catch (e) {
        log.error(`${id}: ${(e as Error).stack ?? e}`);
        void vscode.window.showErrorMessage(`Octave: ${(e as Error).message}`);
      }
    }));

  command('octave.mcp.setup', async () => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Octave: the MCP server needs a trusted workspace (Restricted Mode is on).');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('octave.mcp');
    if (!cfg.get<boolean>('enabled', false)) { await cfg.update('enabled', true, vscode.ConfigurationTarget.Global); }
    await reconcile();
    if (!server) {
      void vscode.window.showErrorMessage('Octave: the MCP server is not running. Check the "octave.mcp.enabled" setting and the "Octave Session" output.');
      return;
    }
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const t = token!;
    const picks: (vscode.QuickPickItem & { text: string; what: string })[] = [
      {
        label: 'Copy Claude Code command', what: 'Claude Code command',
        description: 'claude mcp add --transport http octave ...',
        text: `claude mcp add --transport http octave ${url} --header "Authorization: Bearer ${t}"`,
      },
      {
        label: 'Copy JSON configuration', what: 'JSON configuration',
        description: 'mcpServers entry for Cursor, Copilot and other clients',
        text: JSON.stringify({ mcpServers: { octave: { type: 'http', url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
      },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
      title: `Octave MCP server is running on ${url}`,
      placeHolder: 'Copy the connection details for your AI agent (they contain the access token)',
    });
    if (!pick) { return; }
    await vscode.env.clipboard.writeText(pick.text);
    void vscode.window.showInformationMessage(`Octave: ${pick.what} copied to the clipboard. It contains the access token; keep it private.`);
  });

  command('octave.mcp.resetToken', async () => {
    token = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(TOKEN_KEY, token);
    await reconcile(true);
    void vscode.window.showInformationMessage('Octave: MCP token reset. Configure your AI agents again (Octave: Set Up MCP Server).');
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('octave.mcp')) { void reconcile(); } }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void reconcile(); }),
    { dispose: () => { disposed = true; void reconcile(); } },
  );
  void reconcile();
  return handle;
}

// ---------- tools ----------

interface Frame { name: string; file: string; line: number; }

const BUSY_MESSAGES: Record<string, string> = {
  busy: 'Octave is busy running something else; wait or call octave_interrupt.',
  more: 'Octave is waiting for more input (an unfinished statement typed in the Command Window). Finish or cancel it there first.',
  starting: 'Octave is still starting; try again in a moment.',
  input: 'A command in the Command Window is waiting for keyboard input (input/pause). Answer it there, or call octave_interrupt.',
};

class OctaveTools implements McpBackend {
  private running = false;       // an MCP run/debug command is in flight (one at a time)
  private version: string | undefined;

  constructor(private readonly session: SessionManager) {}

  tools(): ToolDef[] { return TOOLS; }

  async callTool(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'octave_run': return this.run(a.code as string, seconds(a.timeout_seconds));
      case 'octave_run_file': return this.runFile(a.path as string, seconds(a.timeout_seconds));
      case 'octave_status': return this.status();
      case 'octave_workspace': return this.workspace();
      case 'octave_get_value': return this.getValue(a.expression as string, a.max_chars as number | undefined);
      case 'octave_help': return this.help(a.name as string);
      case 'octave_interrupt': return this.interrupt();
      case 'octave_debug': return this.debug(a.action as string);
      case 'octave_breakpoints': return this.breakpoints(a.action as string, a.file as string | undefined, a.line as number | undefined);
      default: return textResult(`Unknown tool: ${name}`, true);
    }
  }

  // ----- running code -----

  private async run(code: string, timeoutS: number): Promise<ToolResult> {
    if (!code.trim()) { return textResult('The code is empty.', true); }
    const display = abbreviate(code);
    return this.exclusive(() => this.session.runBlockCaptured(code, display, timeoutS * 1000), timeoutS);
  }

  private async runFile(file: string, timeoutS: number): Promise<ToolResult> {
    if (!path.isAbsolute(file)) { return textResult(`The path must be absolute: ${file}`, true); }
    if (!/\.m$/i.test(file)) { return textResult(`Only .m files can be run: ${file}`, true); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { return textResult(`File not found: ${file}`, true); }
    return this.exclusive(() => this.session.runScriptCaptured(file, timeoutS * 1000), timeoutS);
  }

  private async debug(action: string): Promise<ToolResult> {
    const cmd = ({ continue: 'dbcont', step: 'dbstep', step_in: 'dbstep in', step_out: 'dbstep out', quit: 'dbquit' } as Record<string, string>)[action];
    if (!cmd) { return textResult(`Unknown debugger action: ${action}`, true); }
    if (this.session.state !== 'debug') {
      return textResult(`Octave is not stopped in the debugger (state: ${this.stateName()}); octave_debug only works at a breakpoint.`, true);
    }
    return this.exclusive(() => this.session.executeCaptured(cmd, 60000), 60);
  }

  /** One MCP run at a time. */
  private async exclusive(fn: () => Promise<CapturedRun>, timeoutS: number): Promise<ToolResult> {
    if (this.running) { return textResult(BUSY_MESSAGES.busy, true); }
    this.running = true;
    try {
      return await this.describeRun(await fn(), timeoutS);
    } finally {
      this.running = false;
    }
  }

  private async describeRun(run: CapturedRun, timeoutS: number): Promise<ToolResult> {
    if (run.kind === 'busy') { return textResult(BUSY_MESSAGES[run.state] ?? BUSY_MESSAGES.busy, true); }
    const out = truncateText(cleanOutput(run.output).trimEnd(), 18000);
    const notes: string[] = [];
    let isError = run.errorSeen;
    switch (run.kind) {
      case 'timeout':
        notes.push(`[Still running after ${timeoutS} s. The output above is what it printed so far; later output appears in the Command Window only. ` +
          'Call octave_status to check on it, or octave_interrupt to abort it.]');
        break;
      case 'debug':
        notes.push(await this.stopNote());
        break;
      case 'cancelled':
        notes.push('[The run was cancelled (interrupted, or Octave exited).]');
        isError = true;
        break;
      case 'more':
        notes.push('[Octave is waiting for more input: the code is incomplete.]');
        isError = true;
        break;
      default:
        if (run.state === 'idle' && !out) { notes.push('(no output)'); }
    }
    return textResult([out, ...notes].filter(Boolean).join('\n'), isError);
  }

  /** "Stopped in the debugger at file:line" for the innermost user frame. */
  private async stopNote(): Promise<string> {
    let frames = await this.stack();
    if (!frames.length) {
      // Stepped off the end of a script: the debug adapter finishes the run; give it a moment.
      const end = Date.now() + 3000;
      while (this.session.state === 'debug' && Date.now() < end) { await sleep(100); frames = await this.stack(); if (frames.length) { break; } }
      if (this.session.state === 'idle') { return '[The program finished; Octave is idle.]'; }
    }
    if (!frames.length) { return `[Octave state: ${this.stateName()}.]`; }
    const top = frames[0];
    return `[Stopped in the debugger at ${top.file}:${top.line} (${top.name}). Octave is waiting in the debugger: use octave_debug to continue, step or quit; ` +
      'octave_workspace shows the variables of this frame.]';
  }

  /** User call stack while stopped in the debugger (innermost first). */
  private async stack(): Promise<Frame[]> {
    if (this.session.state !== 'debug') { return []; }
    const r = await this.session.query('__vsc_stack__();');
    return parseRecords(r.out).filter(f => f[0] === 'F' && !f[2].startsWith('__vsc_'))
      .map(f => ({ file: f[1].replace(/\\/g, '/'), name: f[2], line: Number(f[3]) }));
  }

  // ----- looking things up -----

  private async status(): Promise<ToolResult> {
    const s = this.session.state;
    const lines = [`State: ${this.stateName()}`];
    // With several VS Code windows open, this tells the agent which one it is talking to.
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath.replace(/\\/g, '/'));
    lines.push(`VS Code window: ${folders.length ? folders.join(', ') : '(no folder open)'}`);
    if (s === 'idle' || s === 'debug') {
      const r = await this.session.query('printf("%s\\n%s\\n", OCTAVE_VERSION, pwd());');
      const [version, cwd] = cleanOutput(r.out).split('\n');
      if (version) { this.version = version.trim(); }
      lines.push(`Octave version: ${this.version ?? 'unknown'}`, `Current folder: ${(cwd ?? '').trim().replace(/\\/g, '/')}`);
      if (s === 'debug') {
        const frames = await this.stack();
        lines.push('Call stack (innermost first):', ...frames.map((f, i) => `  #${i} ${f.name}  ${f.file}:${f.line}`));
      }
    } else {
      if (this.version) { lines.push(`Octave version: ${this.version}`); }
      if (s === 'busy' || s === 'input') { lines.push('Octave is running a command; the current folder and call stack are not available until it finishes.'); }
      if (s === 'exited') { lines.push('No Octave session is running. It starts on the first octave_run.'); }
    }
    return textResult(lines.join('\n'));
  }

  private async workspace(): Promise<ToolResult> {
    const problem = await this.queryable();
    if (problem) { return textResult(problem, true); }
    const r = await this.session.query('__vsc_vars__();');
    const rows = parseRecords(r.out).filter(f => f.length >= 5 && f[0] !== 'ERR');
    if (!rows.length) { return textResult(r.err.trim() ? cleanOutput(r.err) : 'The workspace is empty.', !!r.err.trim()); }
    const lines = rows.map(([name, value, type]) => {
      const sp = type.indexOf(' ');
      const preview = value.length > 120 ? value.slice(0, 117) + '...' : value;
      return `${name} | ${type.slice(sp + 1)} | ${type.slice(0, sp)} | ${preview}`;
    });
    const where = this.session.state === 'debug' ? 'current debugger frame' : 'base workspace';
    return textResult(`${rows.length} variable(s) in the ${where} (name | class | size | value):\n${lines.join('\n')}`);
  }

  private async getValue(expression: string, maxChars: number | undefined): Promise<ToolResult> {
    const expr = expression.trim();
    if (!expr) { return textResult('The expression is empty.', true); }
    const problem = await this.queryable();
    if (problem) { return textResult(problem, true); }
    const r = await this.session.query(`__vsc_show__(${octaveLiteral(expr)});`);
    const rec = parseRecords(r.out).find(f => f[0] === 'ERR');
    if (rec) { return textResult(`error: ${rec[1]}`, true); }
    const out = cleanOutput(r.out).trim();
    if (!out && r.err.trim()) { return textResult(cleanOutput(r.err).trim(), true); }
    const limit = Math.min(Math.max(maxChars ?? 4000, 100), 20000);
    return textResult(truncateText(out || '(no output)', limit));
  }

  private async help(name: string): Promise<ToolResult> {
    const n = name.trim();
    if (!/^[A-Za-z_][\w.]*$/.test(n)) { return textResult(`Not a function or command name: ${name}`, true); }
    const problem = await this.queryable();
    if (problem) { return textResult(problem, true); }
    const info = await this.session.helpFor(n);
    const r = await this.session.query(`help(${octaveLiteral(n)});`);
    const text = cleanOutput(r.out).trim();
    const parts: string[] = [];
    if (info?.signatures.length) { parts.push('Usage:\n' + info.signatures.map(s => '  ' + s.label).join('\n')); }
    if (text) { parts.push(text); } else if (info?.doc) { parts.push(info.doc); }
    if (!parts.length) { return textResult(cleanOutput(r.err).trim() || `No help found for "${n}".`, true); }
    return textResult(parts.join('\n\n'));
  }

  private async interrupt(): Promise<ToolResult> {
    if (!this.session.running) { return textResult(`Nothing to interrupt: Octave is ${this.stateName()}.`); }
    const done = new Promise<void>(res => {
      const d = this.session.onDidPrompt(() => { d.dispose(); res(); });
      setTimeout(() => { d.dispose(); res(); }, 5000);
    });
    await this.session.interrupt();
    await done;
    return textResult(`Interrupted. Octave is now ${this.stateName()}.`);
  }

  // ----- breakpoints -----

  private async breakpoints(action: string, file: string | undefined, line: number | undefined): Promise<ToolResult> {
    const sources = () => vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint =>
      b instanceof vscode.SourceBreakpoint && b.location.uri.scheme === 'file');
    const describe = (b: vscode.SourceBreakpoint) =>
      `${b.location.uri.fsPath.replace(/\\/g, '/')}:${b.location.range.start.line + 1}${b.enabled ? '' : ' (disabled)'}`;
    const same = (a: string, b: string) => normPath(a) === normPath(b);

    if (action === 'list') {
      const list = sources();
      return textResult(list.length ? `${list.length} breakpoint(s):\n${list.map(describe).join('\n')}` : 'No breakpoints set.');
    }
    if (!file || !path.isAbsolute(file)) { return textResult('"file" must be an absolute path.', true); }
    if (!/\.m$/i.test(file)) { return textResult('Only .m files can have breakpoints.', true); }
    if (action === 'add') {
      if (!line) { return textResult('"line" is required to add a breakpoint.', true); }
      if (!fs.existsSync(file)) { return textResult(`File not found: ${file}`, true); }
      const existing = sources().find(b => same(b.location.uri.fsPath, file) && b.location.range.start.line + 1 === line);
      if (existing) { return textResult(`Breakpoint already set at ${describe(existing)}.`); }
      const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0)));
      vscode.debug.addBreakpoints([bp]);
      await sleep(100);  // let the debugger sync forward it to Octave
      return textResult(`Breakpoint added at ${describe(bp)}. It applies to the next run.`);
    }
    // remove
    const hits = sources().filter(b => same(b.location.uri.fsPath, file) && (!line || b.location.range.start.line + 1 === line));
    if (!hits.length) { return textResult(`No matching breakpoint in ${file}${line ? ':' + line : ''}.`, true); }
    vscode.debug.removeBreakpoints(hits);
    await sleep(100);
    return textResult(`Removed ${hits.length} breakpoint(s):\n${hits.map(describe).join('\n')}`);
  }

  // ----- helpers -----

  private stateName(): string {
    const s = this.session.state;
    return s === 'exited' ? 'not started' : s === 'more' ? 'waiting for more input' : s;
  }

  /** Starts Octave if needed; a message when queries cannot run now (busy, waiting for input). */
  private async queryable(): Promise<string | undefined> {
    if (this.session.state === 'exited' || this.session.state === 'starting') { await this.session.start(); }
    const s = this.session.state;
    if (s === 'idle' || s === 'debug') { return undefined; }
    return BUSY_MESSAGES[s] ?? `Octave is not available (state: ${s}).`;
  }
}

function seconds(v: unknown): number {
  return Math.min(Math.max(typeof v === 'number' ? v : 60, 1), 600);
}

function normPath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Echo text for the Command Window: short code in full, long code truncated. */
function abbreviate(code: string, maxLines = 8): string {
  const lines = code.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length <= maxLines) { return lines.join('\n'); }
  return [...lines.slice(0, maxLines - 1), `% … ${lines.length - maxLines + 1} more lines`].join('\n');
}
