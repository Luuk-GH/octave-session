import * as vscode from 'vscode';
import { Block, parse, ParseResult } from './parser';

/** Outline, breadcrumbs, folding and section separators for Octave files. */
export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: 'octave' };
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: doc => documentSymbols(doc) },
      { label: 'Octave' }),
    vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: doc => foldingRanges(doc) }),
  );
  registerSectionSeparators(context);
}

// ---------- parsing with a per-version cache ----------

const cache = new WeakMap<vscode.TextDocument, { version: number; result: ParseResult }>();

export function parseDocument(doc: vscode.TextDocument): ParseResult {
  const hit = cache.get(doc);
  if (hit && hit.version === doc.version) { return hit.result; }
  const lines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text); }
  const result = parse(lines);
  cache.set(doc, { version: doc.version, result });
  return result;
}

// ---------- outline ----------

interface Item { sym: vscode.DocumentSymbol; start: number; end: number; }

export function documentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  const p = parseDocument(doc);
  const lineEnd = (l: number) => doc.lineAt(Math.min(l, doc.lineCount - 1)).range.end;
  const range = (s: number, e: number) => new vscode.Range(s, 0, e, lineEnd(e).character);
  const items: Item[] = [];
  const classBlock = p.blocks.find(b => b.kind === 'classdef');

  if (classBlock) {
    const m = /classdef\s*(?:\([^)]*\)\s*)?([A-Za-z_][\w.]*)/.exec(doc.lineAt(classBlock.start).text);
    const name = m?.[1] ?? 'class';
    const col = m ? doc.lineAt(classBlock.start).text.indexOf(name, classBlock.startCol + 8) : classBlock.startCol;
    items.push(item(name, '', vscode.SymbolKind.Class, range(classBlock.start, classBlock.end),
      new vscode.Range(classBlock.start, col, classBlock.start, col + name.length), classBlock.start, classBlock.end));
  }
  for (const f of p.functions) {
    const b = f.block;
    const inMethods = parentKind(p, b) === 'methods';
    const kind = inMethods ? (f.name === classNameOf(doc, classBlock) ? vscode.SymbolKind.Constructor : vscode.SymbolKind.Method)
      : vscode.SymbolKind.Function;
    const sel = new vscode.Range(f.nameLine, f.nameCol, f.nameLine, f.nameCol + f.name.length);
    items.push(item(f.name, f.signature, kind, range(b.start, b.end), sel, b.start, b.end));
  }
  for (const s of p.sections) {
    const title = s.title || `Section at line ${s.start + 1}`;
    const text = doc.lineAt(s.start).text;
    const col = text.search(/\S/);
    items.push(item(title, '', vscode.SymbolKind.Namespace, range(s.start, s.end),
      new vscode.Range(s.start, Math.max(0, col), s.start, text.length), s.start, s.end));
  }
  for (const m of p.members) {
    const kind = m.kind === 'property' ? vscode.SymbolKind.Property : m.kind === 'event' ? vscode.SymbolKind.Event : vscode.SymbolKind.EnumMember;
    const r = new vscode.Range(m.line, m.col, m.line, m.col + m.name.length);
    items.push(item(m.name, '', kind, range(m.line, m.line), r, m.line, m.line));
  }
  return nest(items);
}

function item(name: string, detail: string, kind: vscode.SymbolKind, range: vscode.Range, sel: vscode.Range, start: number, end: number): Item {
  return { sym: new vscode.DocumentSymbol(name, detail, kind, range, sel), start, end };
}

/** Build the tree by containment: an item is a child of the innermost earlier item that contains it. */
function nest(items: Item[]): vscode.DocumentSymbol[] {
  items.sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: vscode.DocumentSymbol[] = [];
  const stack: Item[] = [];
  for (const it of items) {
    while (stack.length && !(stack[stack.length - 1].start <= it.start && stack[stack.length - 1].end >= it.end)) { stack.pop(); }
    if (stack.length) { stack[stack.length - 1].sym.children.push(it.sym); } else { roots.push(it.sym); }
    stack.push(it);
  }
  return roots;
}

function parentKind(p: ParseResult, b: Block): string | undefined {
  return b.parent >= 0 ? p.blocks[b.parent].kind : undefined;
}

function classNameOf(doc: vscode.TextDocument, classBlock: Block | undefined): string | undefined {
  if (!classBlock) { return undefined; }
  return /classdef\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(doc.lineAt(classBlock.start).text)?.[1];
}

// ---------- folding ----------

export function foldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
  const p = parseDocument(doc);
  const out: vscode.FoldingRange[] = [];
  for (const b of p.blocks) {
    // Fold each part (if / elseif / else ...) up to the line before the next keyword; keep `end` visible.
    const marks = [b.start, ...b.mids.filter(m => m > b.start && m < b.end)];
    const stop = b.closed ? b.end : b.end + 1;
    for (let i = 0; i < marks.length; i++) {
      const s = marks[i];
      const e = (i + 1 < marks.length ? marks[i + 1] : stop) - 1;
      if (e > s) { out.push(new vscode.FoldingRange(s, e)); }
    }
  }
  for (const s of p.sections) {
    if (s.end > s.start) { out.push(new vscode.FoldingRange(s.start, s.end, vscode.FoldingRangeKind.Region)); }
  }
  for (const c of [...p.blockComments, ...p.commentRuns]) {
    if (c.end > c.start) { out.push(new vscode.FoldingRange(c.start, c.end, vscode.FoldingRangeKind.Comment)); }
  }
  return out;
}

// ---------- %% section separator lines ----------

function registerSectionSeparators(context: vscode.ExtensionContext): void {
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '1px 0 0 0',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('octave.sectionSeparator'),
  });
  const enabled = () => vscode.workspace.getConfiguration('octave').get<boolean>('sectionSeparators', true);
  const update = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== 'octave') { return; }
    const ranges = enabled()
      ? parseDocument(editor.document).sections.filter(s => s.start > 0).map(s => new vscode.Range(s.start, 0, s.start, 0))
      : [];
    editor.setDecorations(decoration, ranges);
  };
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    decoration,
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(update)),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== 'octave') { return; }
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => vscode.window.visibleTextEditors.filter(ed => ed.document === e.document).forEach(update), 150);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('octave.sectionSeparators')) { vscode.window.visibleTextEditors.forEach(update); }
    }),
    { dispose: () => { if (timer) { clearTimeout(timer); } } },
  );
  vscode.window.visibleTextEditors.forEach(update);
}
