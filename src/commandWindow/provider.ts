import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConsoleView } from '../consoleView';
import { CommandWindowReveal, SessionManager } from '../session';
import { FromWebview, HelpResult, InputMode, TestAction, ToWebview } from './protocol';

const HISTORY_KEY = 'octave.commandWindow.history';
const HISTORY_MAX = 1000;
/** Rendered messages kept for replay when the webview is (re)created: about this many characters. */
const REPLAY_CHARS = 2_000_000;

/**
 * The HTML Command Window: a webview in the bottom panel that shows the shared session (same process and
 * workspace as Run, the debugger, the terminal view and the MCP server). It is one of the session's console
 * views; everything it shows is also kept here, so a webview that is created later (or re-created) can replay it.
 */
export class CommandWindowProvider implements vscode.WebviewViewProvider, ConsoleView, CommandWindowReveal {
  static readonly viewId = 'octave.commandWindow';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private replay: ToWebview[] = [];
  private replayChars = 0;
  private mode: InputMode = 'exited';
  private source: string | undefined;
  private basePrompt = '>>';   // 'K>>' while stopped in the debugger
  private history: string[];
  private testId = 0;
  private readonly testWaiters = new Map<number, (r: unknown) => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly session: SessionManager,
              private readonly log: vscode.LogOutputChannel) {
    this.history = context.globalState.get<string[]>(HISTORY_KEY, []);
    this.disposables.push(session.addView(this));
    this.disposables.push(session.onDidSubmit.event(line => this.addHistory(line)));
    session.registerCommandWindow(this);
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }

  // ---------- vscode.WebviewViewProvider ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = this.context.extensionUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(root, 'dist'), vscode.Uri.joinPath(root, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => { void this.onMessage(m); }, undefined, this.disposables);
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.ready = false; } });
    view.onDidChangeVisibility(() => { if (view.visible) { this.post({ type: 'focus' }); } });
  }

  // ---------- CommandWindowReveal ----------

  reveal(preserveFocus: boolean): void {
    if (this.view) {
      if (!this.view.visible || !preserveFocus) { this.view.show(preserveFocus); }
      if (!preserveFocus) { this.post({ type: 'focus' }); }
      return;
    }
    // Not created yet: opening the view focuses it; give focus back to the editor if asked.
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand(`${CommandWindowProvider.viewId}.focus`).then(() => {
      if (preserveFocus && editor) { void vscode.window.showTextDocument(editor.document, editor.viewColumn, false); }
    });
  }

  // ---------- ConsoleView ----------

  echoCommand(display: string): void {
    const prompt = this.mode === 'more' ? '' : this.basePrompt;
    this.record({ type: 'echo', text: display, prompt });
  }

  writeOutput(text: string, stream: 'out' | 'err'): void { this.record({ type: 'output', text, stream }); }

  showPrompt(kind: 'ready' | 'more' | 'debug'): void {
    if (kind !== 'more') { this.basePrompt = kind === 'debug' ? 'K>>' : '>>'; }
    this.setMode(kind);
  }

  setBusy(): void { this.setMode('busy'); }

  requestInput(source: string): void { this.setMode('input', source); }

  echoInput(text: string): void { this.record({ type: 'echoInput', text }); }

  info(text: string): void { this.record({ type: 'info', text }); }

  clearScreen(): void { this.clear(); }

  resetInput(): void { this.basePrompt = '>>'; this.setMode('exited'); }

  // ---------- commands ----------

  /** Clear the output area (the session and its workspace are not touched). */
  clear(): void {
    this.replay = [];
    this.replayChars = 0;
    this.post({ type: 'clear' });
  }

  /** Current input mode (for tests). */
  get inputMode(): InputMode { return this.mode; }

  /** Run a test action inside the webview and return its result (integration tests only). */
  async test(action: TestAction, timeoutMs = 5000): Promise<any> {
    if (!this.ready) { return undefined; }
    const id = ++this.testId;
    const result = new Promise(res => this.testWaiters.set(id, res));
    this.post({ type: 'test', id, action });
    return Promise.race([result, new Promise(r => setTimeout(() => r(undefined), timeoutMs))]);
  }

  /** Whether the webview has loaded and replayed. */
  get isReady(): boolean { return this.ready; }

  // ---------- internals ----------

  private setMode(mode: InputMode, source?: string): void {
    this.mode = mode;
    this.source = source;
    this.post({ type: 'mode', mode, source });
  }

  private record(msg: ToWebview): void {
    this.replay.push(msg);
    this.replayChars += 'text' in msg ? msg.text.length : 0;
    while (this.replayChars > REPLAY_CHARS && this.replay.length > 1) {
      const old = this.replay.shift()!;
      this.replayChars -= 'text' in old ? old.text.length : 0;
    }
    this.post(msg);
  }

  private post(msg: ToWebview): void {
    if (this.view && this.ready) { void this.view.webview.postMessage(msg); }
  }

  private addHistory(line: string): void {
    if (!line.trim() || this.history[this.history.length - 1] === line) { return; }
    this.history.push(line);
    if (this.history.length > HISTORY_MAX) { this.history.splice(0, this.history.length - HISTORY_MAX); }
    void this.context.globalState.update(HISTORY_KEY, this.history);
    this.post({ type: 'history', entries: this.history });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'history', entries: this.history });
          for (const r of this.replay) { this.post(r); }
          this.post({ type: 'mode', mode: this.mode, source: this.source });
          break;
        case 'submit':
          if (this.mode !== 'input') { this.addHistory(m.code); }
          await this.session.submitFromWindow(m.code, this);
          break;
        case 'stop':
          await this.session.interrupt();
          break;
        case 'complete': {
          const ok = this.mode === 'ready' || this.mode === 'debug';
          const r = ok ? await this.session.completeNames(m.prefix) : undefined;
          this.post({ type: 'completions', id: m.id, items: r ? r.map(([label, kind]) => ({ label, kind })) : null });
          break;
        }
        case 'help':
          this.post({ type: 'help', id: m.id, result: await this.help(m.name) });
          break;
        case 'openFile':
          await this.open(vscode.Uri.file(m.file), m.line);
          break;
        case 'openFunction': {
          const file = await this.session.whichFile(m.name.split('>')[0]);
          if (file) { await this.open(vscode.Uri.file(file), m.line); }
          else { void vscode.window.setStatusBarMessage(`Octave: no file found for ${m.name} (Octave must be idle to look it up)`, 4000); }
          break;
        }
        case 'clear':
          this.clear();
          break;
        case 'testResult':
          this.testWaiters.get(m.id)?.(m.result);
          this.testWaiters.delete(m.id);
          break;
      }
    } catch (err) {
      this.log.error(`Command Window: ${(err as Error).stack ?? err}`);
      if (m.type === 'submit') { void vscode.window.showErrorMessage(`Octave: ${(err as Error).message}`); }
    }
  }

  private async help(name: string): Promise<HelpResult | null> {
    if (this.mode !== 'ready' && this.mode !== 'debug') { return null; }
    const info = await this.session.helpFor(name);
    if (!info || (!info.signatures.length && !info.doc)) { return null; }
    const file = info.file;
    return { name, signatures: info.signatures.map(s => s.label), doc: info.doc, file };
  }

  private async open(uri: vscode.Uri, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = line && line > 0 ? new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0) : undefined;
    await vscode.window.showTextDocument(doc, {
      preview: false, selection: pos ? new vscode.Range(pos, pos) : undefined,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'commandWindow.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commandWindow.css'));
    const testHooks = process.env.OCTAVE_IT_RESULT ? 'true' : 'false';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Octave Command Window</title>
</head>
<body data-test-hooks="${testHooks}" data-nonce="${nonce}">
<div id="output" role="log" aria-live="polite" tabindex="-1"></div>
<div id="hint" aria-live="polite"></div>
<div id="inputRow">
  <span id="prompt">&gt;&gt;</span>
  <div id="editor"></div>
  <button id="stop" title="Stop the running command (Ctrl+C)" hidden><span class="stop-icon"></span>Stop</button>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Register the Command Window view and its commands. */
export function registerCommandWindow(context: vscode.ExtensionContext, session: SessionManager,
                                      log: vscode.LogOutputChannel): CommandWindowProvider {
  const provider = new CommandWindowProvider(context, session, log);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(CommandWindowProvider.viewId, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('octave.commandWindow.clear', () => provider.clear()),
  );
  return provider;
}
