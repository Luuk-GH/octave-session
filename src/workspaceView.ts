import * as vscode from 'vscode';
import { octaveLiteral, parseRecords } from './helpers';
import { SessionManager } from './session';

/** One variable (or element/field of one) as described by the __vsc_vars__ helper. */
export interface WorkspaceVar {
  name: string;
  value: string;
  size: string;
  cls: string;
  /** Octave expression that evaluates to this value (the name for top-level variables). */
  expr: string;
  children: number;
  topLevel: boolean;
}

/** Turn __vsc_vars__ records (name, value, "dims class", expr, child count) into variables. */
export function varsFromRecords(records: string[][], topLevel: boolean): WorkspaceVar[] {
  return records.filter(r => r.length === 5).map(([name, value, type, expr, kids]) => {
    const sp = type.indexOf(' ');
    return {
      name, value, expr, topLevel,
      size: sp === -1 ? type : type.slice(0, sp),
      cls: sp === -1 ? '' : type.slice(sp + 1),
      children: Number(kids) || 0,
    };
  });
}

const REFRESH_DELAY_MS = 150;
const QUERY_TIMEOUT_MS = 5000;

/**
 * The Workspace view: variables of the shared session (of the current frame while debugging), like
 * MATLAB's Workspace browser. It refreshes when Octave returns to a prompt after visible input and when
 * the debugger stops or evaluates something, but only while the view is visible.
 */
export class WorkspaceProvider implements vscode.TreeDataProvider<WorkspaceVar>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WorkspaceVar | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private view: vscode.TreeView<WorkspaceVar> | undefined;
  private roots: WorkspaceVar[] = [];
  private dirty = true;
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<void> | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly session: SessionManager) {
    this.disposables.push(this.changeEmitter,
      session.onDidPrompt(p => { if (!p.hidden && p.kind !== 'more') { this.invalidate(); } }),
      session.onDidExit(() => {
        this.roots = [];
        this.dirty = true;
        this.changeEmitter.fire(undefined);
        this.updateMessage();
      }),
      // Stepping, Debug Console input and Set Value go through hidden queries: follow the debugger instead.
      vscode.debug.registerDebugAdapterTrackerFactory('octave', {
        createDebugAdapterTracker: () => ({
          onDidSendMessage: (m: { type?: string; event?: string; command?: string }) => {
            if ((m.type === 'event' && m.event === 'stopped')
              || (m.type === 'response' && (m.command === 'evaluate' || m.command === 'setVariable'))) {
              this.invalidate();
            }
          },
        }),
      }));
  }

  attach(view: vscode.TreeView<WorkspaceVar>): void {
    this.view = view;
    this.disposables.push(view.onDidChangeVisibility(e => { if (e.visible && this.dirty) { this.invalidate(); } }));
    this.updateMessage();
  }

  /** The workspace may have changed: reload soon if the view is visible, otherwise when it is shown. */
  invalidate(): void {
    this.dirty = true;
    if (!this.view?.visible) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.reload(); }, REFRESH_DELAY_MS);
  }

  private queryable(): boolean {
    const s = this.session.state;
    return s === 'idle' || s === 'debug';
  }

  private async reload(): Promise<void> {
    if (this.loading) { await this.loading; }
    if (!this.dirty) { return; }
    if (!this.queryable()) { this.updateMessage(); return; }  // the next prompt invalidates again
    this.dirty = false;
    this.loading = (async () => {
      const recs = await this.records('__vsc_vars__();');
      if (recs) { this.roots = varsFromRecords(recs, true); } else { this.dirty = true; }
      this.changeEmitter.fire(undefined);
      this.updateMessage();
    })().finally(() => { this.loading = undefined; });
    await this.loading;
  }

  private async records(line: string): Promise<string[][] | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), QUERY_TIMEOUT_MS); });
    try {
      const r = await Promise.race([this.session.query(line), timeout]);
      if (!r || r.kind === 'cancelled') { return undefined; }
      return parseRecords(r.out);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private updateMessage(): void {
    if (!this.view) { return; }
    const s = this.session.state;
    if (s === 'exited') { this.view.message = 'No Octave session. Run a file or open the Command Window to start one.'; }
    else if ((s === 'busy' || s === 'input') && this.dirty) { this.view.message = 'Octave is running; the workspace updates when it finishes.'; }
    else if (s === 'debug') { this.view.message = 'Paused in the debugger: variables of the current frame.'; }
    else if (this.roots.length === 0 && !this.dirty) { this.view.message = 'The workspace is empty.'; }
    else { this.view.message = undefined; }
  }

  getTreeItem(v: WorkspaceVar): vscode.TreeItem {
    const item = new vscode.TreeItem(v.name,
      v.children > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${v.topLevel ? 'v' : 'c'}:${v.expr}`;
    item.description = v.value;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMd(v.expr)}**  \n${escapeMd(v.size)} ${escapeMd(v.cls)}\n\n`);
    tip.appendCodeblock(v.value.length > 1000 ? v.value.slice(0, 1000) + '...' : v.value, 'octave');
    item.tooltip = tip;
    item.iconPath = new vscode.ThemeIcon(iconFor(v));
    item.contextValue = v.topLevel ? 'octaveVariable' : 'octaveElement';
    item.accessibilityInformation = { label: `${v.name}, ${v.size} ${v.cls}, ${v.value}` };
    return item;
  }

  async getChildren(v?: WorkspaceVar): Promise<WorkspaceVar[]> {
    if (!v) {
      if (this.dirty && this.view?.visible && this.queryable() && !this.timer) { await this.reload(); }
      return this.roots;
    }
    if (!this.queryable()) { return []; }
    const recs = await this.records(`__vsc_vars__(${octaveLiteral(v.expr)});`);
    return recs ? varsFromRecords(recs, false) : [];
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); }
    for (const d of this.disposables) { d.dispose(); }
  }
}

function iconFor(v: WorkspaceVar): string {
  switch (v.cls) {
    case 'struct': return 'symbol-structure';
    case 'cell': return 'symbol-array';
    case 'char': case 'string': return 'symbol-string';
    case 'logical': return 'symbol-boolean';
    case 'function_handle': return 'symbol-function';
  }
  if (/int|double|single/.test(v.cls)) { return v.size === '1x1' ? 'symbol-number' : 'symbol-array'; }
  return 'symbol-object';
}

function escapeMd(s: string): string {
  return s.replace(/[*_`[\]<>#|\\]/g, m => '&#' + m.charCodeAt(0) + ';');
}

/** Register the Workspace view and its commands. */
export function registerWorkspaceView(context: vscode.ExtensionContext, session: SessionManager): WorkspaceProvider {
  const provider = new WorkspaceProvider(session);
  const view = vscode.window.createTreeView('octave.workspace', {
    treeDataProvider: provider, showCollapseAll: true, canSelectMany: true,
  });
  provider.attach(view);
  const busy = (): boolean => {
    if (!session.running) { return false; }
    void vscode.window.showInformationMessage('Octave: wait for the running command to finish (or press Ctrl+C).');
    return true;
  };
  context.subscriptions.push(provider, view,
    vscode.commands.registerCommand('octave.workspace.refresh', () => provider.invalidate()),
    vscode.commands.registerCommand('octave.workspace.show', async (v?: WorkspaceVar) => {
      if (v) { await session.execute(v.expr); }
    }),
    vscode.commands.registerCommand('octave.workspace.copyValue', async (v?: WorkspaceVar) => {
      if (v) { await vscode.env.clipboard.writeText(v.value); }
    }),
    vscode.commands.registerCommand('octave.workspace.copyExpression', async (v?: WorkspaceVar) => {
      if (v) { await vscode.env.clipboard.writeText(v.expr); }
    }),
    vscode.commands.registerCommand('octave.workspace.delete', async (v?: WorkspaceVar, all?: WorkspaceVar[]) => {
      const names = (all && all.length ? all : v ? [v] : []).filter(x => x.topLevel).map(x => x.name);
      if (!names.length || busy()) { return; }
      await session.execute(`clear ${names.join(' ')}`);
    }),
    vscode.commands.registerCommand('octave.workspace.clear', async () => {
      if (session.state === 'exited' || busy()) { return; }
      const ok = await vscode.window.showWarningMessage('Clear all variables from the Octave workspace?', { modal: true }, 'Clear');
      if (ok === 'Clear') { await session.execute('clear'); }
    }),
  );
  return provider;
}
