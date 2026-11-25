import * as vscode from 'vscode';
import type { CompletionKind as Kind, SessionManager } from '../session';
import { HelpInfo } from './help';
import { parseDocument } from './providers';
import { callContext, completionPrefix, Signature, signatureFromDeclaration } from './signatures';

/**
 * Completion and signature help backed by the shared Octave session.
 *
 * - Live: `completion_matches` in the session (functions on the path, keywords, workspace variables of the
 *   current frame, struct fields) when Octave is at a prompt.
 * - Fallback while Octave is busy or not started: the last full list, kept in global state across restarts.
 * - Always: functions declared in the document (with their signatures) and words used in it.
 */

const CACHE_KEY = 'octave.completionCache.v1';
const QUERY_TIMEOUT_MS = 1500;

export function registerCompletion(context: vscode.ExtensionContext, session: SessionManager): void {
  const provider = new OctaveCompletion(context, session);
  const selector: vscode.DocumentSelector = { language: 'octave' };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, provider, '.'),
    vscode.languages.registerSignatureHelpProvider(selector, provider, { triggerCharacters: ['(', ','], retriggerCharacters: [','] }),
    provider,
  );
}

class OctaveCompletion implements vscode.CompletionItemProvider, vscode.SignatureHelpProvider, vscode.Disposable {
  private cache: Map<string, Kind>;
  private lastRefresh = 0;
  private refreshing = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly session: SessionManager) {
    const stored = context.globalState.get<[string, Kind][]>(CACHE_KEY) ?? [];
    this.cache = new Map(stored);
    // Refresh the fallback list when Octave reaches its prompt (after start, and at most once a minute after runs).
    this.disposables.push(session.onDidPrompt(e => {
      if (e.kind !== 'ready' || e.hidden || this.refreshing || Date.now() - this.lastRefresh < 60000) { return; }
      void this.refreshCache();
    }));
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }

  // ---------- completion ----------

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken,
                               ctx: vscode.CompletionContext): Promise<vscode.CompletionItem[] | undefined> {
    const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    const cp = completionPrefix(linePrefix);
    if (!cp) { return undefined; }
    if (!cp.prefix && ctx.triggerKind !== vscode.CompletionTriggerKind.Invoke) { return undefined; }
    const range = new vscode.Range(pos.line, cp.segmentStart, pos.line, pos.character);
    const dotted = cp.prefix.includes('.');
    const items = new Map<string, vscode.CompletionItem>();
    const add = (name: string, kind: Kind | 'local' | 'word', detail?: string) => {
      const label = dotted ? name.slice(name.lastIndexOf('.') + 1) : name;
      if (!label || items.has(label)) { return; }
      const it = new vscode.CompletionItem(label, KIND[kind]);
      it.range = range;
      it.sortText = SORT[kind] + label.toLowerCase();
      it.detail = detail ?? DETAIL[kind];
      if (kind === 'F' || kind === 'local') { (it as OctaveItem).octaveName = name; }
      items.set(label, it);
    };

    // 1. The live session (fresh variables, fields, path functions).
    const live = await this.liveMatches(cp.prefix);
    if (token.isCancellationRequested) { return undefined; }
    // 2. Functions declared in this document, with their signatures.
    const parsed = parseDocument(doc);
    if (!dotted) {
      for (const f of parsed.functions) {
        if (f.name.startsWith(cp.prefix)) { add(f.name, 'local', f.signature); }
      }
    }
    if (live) {
      for (const [name, kind] of live) { add(name, kind); }
    } else if (!dotted) {
      // 3. Fallback: the cached list from the last session.
      for (const [name, kind] of this.cache) {
        if (name.startsWith(cp.prefix) && kind !== 'v') { add(name, kind); }
      }
    }
    // 4. Words used in this document (variables you typed, fields after "s.").
    for (const w of documentWords(doc, cp.prefix, pos)) { add(w, 'word'); }
    return [...items.values()];
  }

  async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
    const name = (item as OctaveItem).octaveName;
    if (!name || item.kind === vscode.CompletionItemKind.Variable) { return item; }
    const info = await this.helpFor(name);
    if (!info || token.isCancellationRequested) { return item; }
    if (info.signatures.length) { item.detail = info.signatures.map(s => s.label).slice(0, 3).join('\n'); }
    if (info.doc) { item.documentation = new vscode.MarkdownString(info.doc); }
    return item;
  }

  // ---------- signature help ----------

  async provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
    // The code before the cursor, including earlier lines joined with "..." continuations.
    let text = doc.lineAt(pos.line).text.slice(0, pos.character);
    for (let l = pos.line - 1; l >= 0 && l > pos.line - 20; l--) {
      const prev = doc.lineAt(l).text;
      if (!/\.\.\.(?:[^'"]*)$/.test(prev)) { break; }
      text = prev.replace(/\.\.\..*$/, ' ') + text;
    }
    const call = callContext(text);
    if (!call) { return undefined; }

    let signatures: Signature[] = [];
    let doc0 = '';
    const local = parseDocument(doc).functions.find(f => f.name === call.name);
    if (local) {
      signatures = [signatureFromDeclaration(local.signature)];
    } else {
      const info = await this.helpFor(call.name);
      if (token.isCancellationRequested) { return undefined; }
      if (info) { signatures = info.signatures; doc0 = info.doc; }
    }
    if (!signatures.length) { return undefined; }

    const help = new vscode.SignatureHelp();
    help.signatures = signatures.map(s => {
      const si = new vscode.SignatureInformation(s.label, doc0 ? new vscode.MarkdownString(doc0) : undefined);
      si.parameters = s.params.map(p => new vscode.ParameterInformation(p));
      return si;
    });
    const isVarargs = (s: Signature, i: number) => {
      const p = s.params[i];
      return p ? /^\.\.\.$|varargin/.test(s.label.slice(p[0], p[1])) : false;
    };
    // Prefer the first form with enough parameters (or a trailing "..." / varargin).
    let active = signatures.findIndex(s => s.params.length > call.param);
    if (active < 0) { active = signatures.findIndex(s => s.params.length && isVarargs(s, s.params.length - 1)); }
    help.activeSignature = Math.max(0, active);
    const sig = signatures[help.activeSignature];
    help.activeParameter = call.param < sig.params.length ? call.param
      : (sig.params.length && isVarargs(sig, sig.params.length - 1) ? sig.params.length - 1 : call.param);
    return help;
  }

  // ---------- Octave queries ----------

  private canQuery(): boolean {
    const s = this.session.state;
    return s === 'idle' || s === 'debug';
  }

  private liveMatches(prefix: string): Promise<[string, Kind][] | undefined> {
    return this.session.completeNames(prefix, QUERY_TIMEOUT_MS);
  }

  private async refreshCache(): Promise<void> {
    if (!this.canQuery()) { return; }
    this.refreshing = true;
    try {
      const list = (await this.session.completeNames('', 10000))?.filter(([, k]) => k !== 'f');
      if (list && list.length > 100) {
        this.cache = new Map(list);
        this.lastRefresh = Date.now();
        await this.context.globalState.update(CACHE_KEY, list.filter(([, k]) => k !== 'v'));
      }
    } finally {
      this.refreshing = false;
    }
  }

  private helpFor(name: string): Promise<HelpInfo | undefined> {
    return this.session.helpFor(name);
  }
}

interface OctaveItem extends vscode.CompletionItem { octaveName?: string; }

const KIND: Record<Kind | 'local' | 'word', vscode.CompletionItemKind> = {
  v: vscode.CompletionItemKind.Variable, f: vscode.CompletionItemKind.Field, k: vscode.CompletionItemKind.Keyword,
  F: vscode.CompletionItemKind.Function, local: vscode.CompletionItemKind.Function, word: vscode.CompletionItemKind.Text,
};
const SORT: Record<Kind | 'local' | 'word', string> = { v: '0', f: '0', local: '1', F: '2', k: '3', word: '4' };
const DETAIL: Record<Kind | 'local' | 'word', string> = {
  v: 'variable', f: 'field', k: 'keyword', F: 'function', local: 'function in this file', word: '',
};

/** Identifiers used in the document that start with `prefix` (fields after a dotted prefix). */
function documentWords(doc: vscode.TextDocument, prefix: string, pos: vscode.Position): string[] {
  const out = new Set<string>();
  const text = doc.getText();
  const dot = prefix.lastIndexOf('.');
  const re = dot >= 0
    ? new RegExp(`(?<![\\w.])${escapeRe(prefix.slice(0, dot + 1))}([A-Za-z_]\\w*)`, 'g')
    : /(?<![\w.])[A-Za-z_]\w*/g;
  const cursorOffset = doc.offsetAt(pos);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (end === cursorOffset) { continue; }  // the word being typed
    const word = dot >= 0 ? prefix.slice(0, dot + 1) + m[1] : m[0];
    if (word.startsWith(prefix) && word !== prefix) { out.add(word); }
    if (out.size > 2000) { break; }
  }
  return [...out];
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

