import * as path from 'path';
import * as vscode from 'vscode';
import { CommandWindowProvider, registerCommandWindow } from './commandWindow/provider';
import { registerDebugger } from './debug';
import { registerCompletion } from './language/completion';
import { registerLanguageFeatures } from './language/providers';
import { McpHandle, registerMcp } from './mcp';
import { sectionAt } from './sections';
import { registerWorkspaceView, WorkspaceProvider } from './workspaceView';
import { ReportedError, SessionManager } from './session';

let session: SessionManager | undefined;

export interface OctaveExtensionApi {
  session: SessionManager; mcp: McpHandle; workspace: WorkspaceProvider; commandWindow: CommandWindowProvider;
}

export function activate(context: vscode.ExtensionContext): OctaveExtensionApi {
  const log = vscode.window.createOutputChannel('Octave Session', { log: true });
  session = new SessionManager(context, log);
  const s = session;

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try { await fn(...args); } catch (err) {
        log.error(`${id}: ${(err as Error).stack ?? err}`);
        if (!(err as ReportedError).reported) { void vscode.window.showErrorMessage(`Octave: ${(err as Error).message}`); }
      }
    }));

  reg('octave.runFile', (uri?: vscode.Uri) => runFile(s, uri));
  reg('octave.runSelection', () => runSelection(s));
  reg('octave.runSection', () => runSection(s));
  reg('octave.interrupt', () => s.interrupt());
  reg('octave.restart', () => s.restart());
  reg('octave.showTerminal', () => s.show());
  reg('octave.showRawTerminal', () => s.showTerminal());

  context.subscriptions.push(s, log);
  const commandWindow = registerCommandWindow(context, s, log);
  registerDebugger(context, s, log);
  registerLanguageFeatures(context);
  registerCompletion(context, s);
  const workspace = registerWorkspaceView(context, s);
  checkMatlabAssociation(context);
  const mcp = registerMcp(context, s, log);
  return { session: s, mcp, workspace, commandWindow };
}

/**
 * The MathWorks MATLAB extension also claims .m files; then they open as "matlab" and none of this
 * extension's features apply. Offer (once) to open .m files as Octave.
 */
function checkMatlabAssociation(context: vscode.ExtensionContext): void {
  const KEY = 'octave.matlabAssociationAsked';
  const check = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'matlab' || !/\.m$/i.test(doc.fileName) || context.globalState.get(KEY)) { return; }
    void context.globalState.update(KEY, true);
    void vscode.window.showInformationMessage(
      'This .m file opened as MATLAB (another extension claims .m files). Open .m files as Octave to use Run, the debugger and completion?',
      'Use Octave for .m files', 'Not now').then(async choice => {
      if (choice !== 'Use Octave for .m files') { return; }
      const cfg = vscode.workspace.getConfiguration('files');
      const assoc = { ...(cfg.inspect<Record<string, string>>('associations')?.globalValue ?? {}), '*.m': 'octave' };
      await cfg.update('associations', assoc, vscode.ConfigurationTarget.Global);
      for (const d of vscode.workspace.textDocuments) {
        if (d.languageId === 'matlab' && /\.m$/i.test(d.fileName)) { await vscode.languages.setTextDocumentLanguage(d, 'octave'); }
      }
    });
  };
  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(check));
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}

/** Run File (F5 / ▶): save, then run the script in the base workspace. Untitled buffers run as a block. */
async function runFile(s: SessionManager, uri?: vscode.Uri): Promise<void> {
  let doc: vscode.TextDocument | undefined;
  if (uri) {
    doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
      ?? await vscode.workspace.openTextDocument(uri);
  } else {
    doc = vscode.window.activeTextEditor?.document;
  }
  if (!doc) { void vscode.window.showWarningMessage('Octave: no file to run.'); return; }

  if (doc.isUntitled || doc.uri.scheme !== 'file') {
    // Not a file on this disk (untitled, diff view, remote...): run the editor's text instead.
    await s.executeBlock(doc.getText(), `% run ${path.basename(doc.fileName)}`);
    return;
  }
  if (doc.isDirty && !(await doc.save())) { return; }
  // Called by name from the script's folder, so breakpoints apply (a stop opens the debugger).
  await s.runScript(doc.uri.fsPath);
}

/** Run Selection (F9): the selection, or the current line when nothing is selected. */
async function runSelection(s: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const doc = editor.document;
  const parts = editor.selections
    .slice()
    .sort((a, b) => a.start.compareTo(b.start))
    .map(sel => sel.isEmpty ? doc.lineAt(sel.active.line).text : doc.getText(sel));
  const code = parts.join('\n');
  if (!code.trim()) { return; }
  await s.executeBlock(code, abbreviate(code));
}

/** Run Section (Ctrl+Enter): the `%%` cell around the cursor. */
async function runSection(s: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const doc = editor.document;
  const lines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text); }
  const sec = sectionAt(lines, editor.selection.active.line);
  const code = lines.slice(sec.start, sec.end + 1).join('\n');
  const label = sec.title ? `"${sec.title}"` : `#${sec.index}`;
  flashRange(editor, sec.start, sec.end);
  await s.executeBlock(code, `% section ${label} of ${path.basename(doc.fileName)} (lines ${sec.start + 1}-${sec.end + 1})`);
}

/** Echo text for the Command Window: short code is shown in full, long code is truncated. */
function abbreviate(code: string, maxLines = 8): string {
  const lines = code.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length <= maxLines) { return lines.join('\n'); }
  return [...lines.slice(0, maxLines - 1), `% … ${lines.length - maxLines + 1} more lines`].join('\n');
}

const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  isWholeLine: true,
});

function flashRange(editor: vscode.TextEditor, start: number, end: number): void {
  editor.setDecorations(flashDecoration, [new vscode.Range(start, 0, end, 0)]);
  setTimeout(() => editor.setDecorations(flashDecoration, []), 400);
}
