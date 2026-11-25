// The Command Window webview: an HTML output area and a CodeMirror 6 input line. It only renders and
// edits; everything runs in the extension's shared Octave session (see ../provider.ts).
import { acceptCompletion, autocompletion, closeCompletion, Completion, CompletionContext, CompletionResult,
  completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history as undoHistory, historyKeymap, indentMore, insertNewlineAndIndent } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, StreamLanguage, StringStream, syntaxHighlighting } from '@codemirror/language';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, hoverTooltip, keymap, placeholder, Tooltip } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { callContext, completionPrefix } from '../../language/signatures';
import type { CompletionItem, FromWebview, HelpResult, InputMode, Snapshot, TestAction, ToWebview } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const outputEl = document.getElementById('output')!;
const promptEl = document.getElementById('prompt')!;
const stopEl = document.getElementById('stop') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;
const testHooks = document.body.dataset.testHooks === 'true';

/** Output blocks longer than this many lines are collapsed once their command finishes. */
const COLLAPSE_LINES = 40;
/** Oldest blocks are dropped beyond this many. */
const MAX_BLOCKS = 1000;
/** "called from" frames of the extension's own helpers. */
const HELPER_FRAME = /^\s+__vsc_\w+__ at line \d+(?: column \d+)?\r?\n?/gm;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CLEAR_SCREEN = /\x1b\[2J|\x1bc|\f/;

let mode: InputMode = 'exited';
let inputSource: string | undefined;
let history: string[] = [];

// ---------------------------------------------------------------------------------------------------------
// Syntax highlighting (input line and echoed commands), with VS Code theme colours where available.

const octaveLanguage = StreamLanguage.define(octave);
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cw-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cw-string)' },
  { tag: t.number, color: 'var(--cw-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--cw-comment)', fontStyle: 'italic' },
  { tag: t.standard(t.variableName), color: 'var(--cw-builtin)' },
  { tag: t.operator, color: 'var(--cw-operator)' },
  { tag: t.bracket, color: 'var(--cw-bracket)' },
]);

/** Highlighted DOM for a piece of code (echoed commands in the output), using the same Octave tokenizer. */
function highlightedCode(code: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parser = octave as unknown as { startState(): unknown; token(s: StringStream, st: unknown): string | null };
  const state = parser.startState();
  code.split('\n').forEach((line, n) => {
    if (n > 0) { frag.append('\n'); }
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const start = stream.pos;
      const style = parser.token(stream, state);
      if (stream.pos === start) { stream.next(); }   // never loop without progress
      const text = line.slice(start, stream.pos);
      if (style && style !== 'variable') {
        const span = document.createElement('span');
        span.className = `tok-${style.split(' ')[0]}`;
        span.textContent = text;
        frag.append(span);
      } else {
        frag.append(text);
      }
      stream.start = stream.pos;
    }
  });
  return frag;
}

// ---------------------------------------------------------------------------------------------------------
// Output area

interface Block { el: HTMLElement; out: HTMLElement; lines: number; done: boolean; }
let afterStop = false;   // the previous stderr line was the debugger's "stopped in ..." line
let current: Block | undefined;

function stickToBottom(): boolean {
  return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
}
function scrollDown(stick: boolean): void { if (stick) { outputEl.scrollTop = outputEl.scrollHeight; } }

function newBlock(): Block {
  finishBlock();
  const el = document.createElement('div');
  el.className = 'block';
  const out = document.createElement('pre');
  out.className = 'out';
  el.append(out);
  outputEl.append(el);
  while (outputEl.childElementCount > MAX_BLOCKS) { outputEl.firstElementChild!.remove(); }
  current = { el, out, lines: 0, done: false };
  return current;
}

function block(): Block { return current && !current.done ? current : newBlock(); }

/** Collapse a finished block whose output is long; a button shows it all again. */
function finishBlock(): void {
  const b = current;
  if (!b || b.done) { return; }
  b.done = true;
  const lines = b.out.textContent!.split('\n').length - (b.out.textContent!.endsWith('\n') ? 1 : 0);
  if (lines <= COLLAPSE_LINES) { return; }
  b.el.classList.add('collapsible', 'collapsed');
  const btn = document.createElement('button');
  btn.className = 'toggle';
  const label = () => { btn.textContent = b.el.classList.contains('collapsed') ? `▸ Show all ${lines} lines` : '▴ Collapse output'; };
  label();
  btn.addEventListener('click', () => { b.el.classList.toggle('collapsed'); label(); });
  b.el.append(btn);
}

function echo(text: string, prompt: string): void {
  const stick = true;
  const b = newBlock();
  const cmd = document.createElement('div');
  cmd.className = 'cmd';
  const p = document.createElement('span');
  p.className = 'cmd-prompt';
  p.textContent = prompt ? prompt + ' ' : '';
  const code = document.createElement('span');
  code.className = 'cmd-code';
  code.append(highlightedCode(text));
  cmd.append(p, code);
  b.el.insertBefore(cmd, b.out);
  scrollDown(stick);
}

function output(text: string, stream: 'out' | 'err'): void {
  const stick = stickToBottom();
  const cls = CLEAR_SCREEN.exec(text);
  if (cls) {   // clc
    clearOutput();
    text = text.slice(cls.index + cls[0].length);
  }
  text = text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  if (stream === 'err') { text = text.replace(HELPER_FRAME, ''); }
  if (!text) { return; }
  const b = block();
  if (stream === 'err') {
    // Errors in red, warnings in yellow, the debugger's location ("stopped in ..." + "N: code") dim, line by line.
    for (const seg of text.split(/(?<=\n)/)) {
      const span = document.createElement('span');
      const isStop = /^stopped in /.test(seg);
      const isCodeLine = afterStop && /^\d+: /.test(seg);
      afterStop = isStop;
      span.className = isStop || isCodeLine ? 'dbg' : /^\s*warning:/.test(seg) ? 'warn' : 'err';
      span.append(linkify(seg, true));
      b.out.append(span);
    }
  } else {
    b.out.append(linkify(text, false));
  }
  scrollDown(stick);
}

function stdinEcho(text: string): void {
  const span = document.createElement('span');
  span.className = 'stdin';
  span.textContent = text + '\n';
  block().out.append(span);
  scrollDown(true);
}

function info(text: string): void {
  finishBlock();
  const div = document.createElement('div');
  div.className = 'info';
  div.textContent = text;
  outputEl.append(div);
  current = undefined;
  scrollDown(true);
}

function clearOutput(): void {
  outputEl.textContent = '';
  current = undefined;
}

// ---- file:line links ----

const WIN_PATH = String.raw`[A-Za-z]:[\\/][^\s"'<>|*?\[\]]*?\.m`;
const WIN_PATH_SPACES = String.raw`[A-Za-z]:[\\/][^"'<>|*?\[\]\n]*?\.m`;
const LINK_PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => { file?: string; func?: string; line?: number; start: number; end: number } }[] = [
  // parse error near line 3 of file C:\x\y.m
  { re: new RegExp(String.raw`line (\d+)(?:, column \d+)? of file (${WIN_PATH_SPACES})`, 'g'),
    make: m => ({ file: m[2], line: +m[1], start: m.index, end: m.index + m[0].length }) },
  // stopped in f at line 3 [C:\x\y.m]
  { re: new RegExp(String.raw`at line (\d+) \[(${WIN_PATH_SPACES})\s*\]`, 'g'),
    make: m => ({ file: m[2], line: +m[1], start: m.index, end: m.index + m[0].length }) },
  // 'f' is a function from the file C:\Program Files\...\f.m
  { re: new RegExp(String.raw`from the file (${WIN_PATH_SPACES})$`, 'gm'),
    make: m => ({ file: m[1], start: m.index + m[0].length - m[1].length, end: m.index + m[0].length }) },
  // any C:\path\file.m (optionally :line)
  { re: new RegExp(String.raw`(${WIN_PATH})(?::(\d+))?`, 'g'),
    make: m => ({ file: m[1], line: m[2] ? +m[2] : undefined, start: m.index, end: m.index + m[0].length }) },
  // /unix/path/file.m (optionally :line)
  { re: /(?<![\w.])(\/[^\s"'<>|*?:]+\.m)(?::(\d+))?/g,
    make: m => ({ file: m[1], line: m[2] ? +m[2] : undefined, start: m.index, end: m.index + m[0].length }) },
];
// "called from" frame of an error:   myfun at line 12 column 5
const FRAME = /^(\s+)([A-Za-z_][\w.>@\/-]*) at line (\d+)(?: column \d+)?$/gm;

function linkify(text: string, isErr: boolean): DocumentFragment {
  type Hit = { file?: string; func?: string; line?: number; start: number; end: number };
  const hits: Hit[] = [];
  for (const p of LINK_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const h = p.make(m);
      if (!hits.some(o => h.start < o.end && o.start < h.end)) { hits.push(h); }
    }
  }
  if (isErr) {
    FRAME.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FRAME.exec(text))) {
      const start = m.index + m[1].length;
      const h = { func: m[2], line: +m[3], start, end: m.index + m[0].length };
      if (!hits.some(o => h.start < o.end && o.start < h.end)) { hits.push(h); }
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) { frag.append(text.slice(pos, h.start)); }
    const a = document.createElement('a');
    a.className = 'link';
    a.textContent = text.slice(h.start, h.end);
    a.title = h.file ? `Open ${h.file}${h.line ? ` at line ${h.line}` : ''}` : `Open ${h.func}${h.line ? ` at line ${h.line}` : ''}`;
    if (h.file) { a.dataset.file = h.file; }
    if (h.func) { a.dataset.func = h.func; }
    if (h.line) { a.dataset.line = String(h.line); }
    frag.append(a);
    pos = h.end;
  }
  if (pos < text.length) { frag.append(text.slice(pos)); }
  return frag;
}

outputEl.addEventListener('click', e => {
  const a = (e.target as HTMLElement).closest('a.link') as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    const line = a.dataset.line ? Number(a.dataset.line) : undefined;
    if (a.dataset.file) { post({ type: 'openFile', file: a.dataset.file, line }); }
    else if (a.dataset.func) { post({ type: 'openFunction', name: a.dataset.func, line }); }
  }
});
// A click in the output that does not select text puts the cursor back in the input line.
outputEl.addEventListener('mouseup', e => {
  if ((e.target as HTMLElement).closest('a, button')) { return; }
  if (!window.getSelection()?.toString()) { editor.focus(); }
});

// ---------------------------------------------------------------------------------------------------------
// Requests to the extension (completion, help)

let requestId = 0;
const waiting = new Map<number, (v: any) => void>();
function request<T>(msg: (id: number) => FromWebview, timeoutMs = 3000): Promise<T | null> {
  const id = ++requestId;
  return new Promise(res => {
    const timer = setTimeout(() => { waiting.delete(id); res(null); }, timeoutMs);
    waiting.set(id, v => { clearTimeout(timer); res(v); });
    post(msg(id));
  });
}
const canQuery = () => mode === 'ready' || mode === 'debug';

const helpCache = new Map<string, Promise<HelpResult | null>>();
function fetchHelp(name: string): Promise<HelpResult | null> {
  if (!canQuery()) { return Promise.resolve(null); }
  let p = helpCache.get(name);
  if (!p) {
    p = request<HelpResult>(id => ({ type: 'help', id, name }));
    helpCache.set(name, p);
    void p.then(r => { if (!r) { helpCache.delete(name); } });
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Input line

const KIND_TYPE: Record<CompletionItem['kind'], string> = { v: 'variable', f: 'property', k: 'keyword', F: 'function' };

async function completionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!canQuery()) { return null; }
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const cp = completionPrefix(before);
  if (!cp) { return null; }
  const segment = before.slice(cp.segmentStart);
  if (!ctx.explicit && segment.length < 2 && !cp.prefix.includes('.')) { return null; }
  const items = await request<CompletionItem[]>(id => ({ type: 'complete', id, prefix: cp.prefix }));
  if (!items || ctx.aborted) { return null; }
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const it of items) {
    const label = it.label.slice(it.label.lastIndexOf('.') + 1);
    if (seen.has(label)) { continue; }
    seen.add(label);
    options.push({ label, type: KIND_TYPE[it.kind] ?? 'text', boost: it.kind === 'v' || it.kind === 'f' ? 2 : 0 });
  }
  return { from: line.from + cp.segmentStart, options, validFor: /^\w*$/ };
}

function helpDom(r: HelpResult): HTMLElement {
  const div = document.createElement('div');
  div.className = 'help';
  for (const s of r.signatures.slice(0, 6)) {
    const code = document.createElement('div');
    code.className = 'help-sig';
    code.textContent = s;
    div.append(code);
  }
  if (r.doc) {
    const d = document.createElement('div');
    d.className = 'help-doc';
    d.textContent = r.doc.length > 400 ? r.doc.slice(0, 397) + '…' : r.doc;
    div.append(d);
  }
  if (r.file) {
    const f = document.createElement('a');
    f.className = 'link help-file';
    f.textContent = r.file;
    f.addEventListener('mousedown', e => { e.preventDefault(); post({ type: 'openFile', file: r.file! }); });
    div.append(f);
  }
  return div;
}

/** Hover over a name in the input line: its usage and description from Octave's help (and `which`). */
const helpHover = hoverTooltip((view, pos): Tooltip | null => {
  if (!canQuery()) { return null; }
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    if (m.index <= col && col <= m.index + m[0].length) {
      const name = m[0];
      return {
        pos: line.from + m.index, end: line.from + m.index + name.length, above: true,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'help-tooltip';
          dom.textContent = '…';
          void fetchHelp(name).then(r => { dom.textContent = ''; dom.append(r ? helpDom(r) : document.createTextNode(`No help for ${name}`)); });
          return { dom };
        },
      };
    }
  }
  return null;
}, { hoverTime: 400 });

// ---- history (Up/Down filtered by the text typed before browsing) ----
const fromHistory = Annotation.define<boolean>();
let histIndex = -1;       // -1: editing a new line
let histDraft = '';

function setInput(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    annotations: fromHistory.of(true),
  });
}

function historyMove(view: EditorView, delta: number): boolean {
  if (!history.length || mode === 'input') { return false; }
  const prefix = histIndex === -1 ? view.state.doc.toString() : histDraft;
  let idx = histIndex;
  if (idx === -1) { if (delta > 0) { return false; } histDraft = view.state.doc.toString(); idx = history.length; }
  for (;;) {
    idx += delta;
    if (idx < 0) { return true; }
    if (idx >= history.length) { histIndex = -1; setInput(view, histDraft); return true; }
    if (history[idx].startsWith(prefix) && history[idx] !== view.state.doc.toString()) {
      histIndex = idx;
      setInput(view, history[idx]);
      return true;
    }
  }
}

function submit(view: EditorView): boolean {
  const code = view.state.doc.toString();
  if (!code.trim() && mode !== 'input' && mode !== 'more') { return true; }
  post({ type: 'submit', code });
  histIndex = -1;
  histDraft = '';
  if (mode !== 'input' && code.trim() && history[history.length - 1] !== code) { history.push(code); }
  setInput(view, '');
  hintEl.textContent = '';
  return true;
}

const stop = () => { post({ type: 'stop' }); return true; };

const inputKeys = Prec.high(keymap.of([
  { key: 'Enter', run: v => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : submit(v)) },
  { key: 'Shift-Enter', run: insertNewlineAndIndent },
  {
    key: 'ArrowUp',
    run: v => completionStatus(v.state) === 'active' ? false
      : v.state.doc.lineAt(v.state.selection.main.head).number === 1 ? historyMove(v, -1) : false,
  },
  {
    key: 'ArrowDown',
    run: v => completionStatus(v.state) === 'active' ? false
      : v.state.doc.lineAt(v.state.selection.main.head).number === v.state.doc.lines ? historyMove(v, 1) : false,
  },
  {
    key: 'Escape',
    run: v => {
      if (completionStatus(v.state)) { return closeCompletion(v); }
      if (v.state.doc.length) { setInput(v, ''); histIndex = -1; return true; }
      return false;
    },
  },
  {
    key: 'Tab',
    run: v => {
      if (completionStatus(v.state) === 'active') { return acceptCompletion(v); }
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      const cp = completionPrefix(line.text.slice(0, head - line.from));
      if (canQuery() && cp?.prefix) { return startCompletion(v); }
      return indentMore(v);
    },
  },
  { key: 'Ctrl-c', run: v => (v.state.selection.main.empty && (mode === 'busy' || mode === 'input') ? stop() : false) },
  { key: 'Ctrl-l', run: () => { post({ type: 'clear' }); return true; } },
]));

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'var(--cw-line-height)' },
  '.cm-content': { padding: '0', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorHoverWidget-background)', color: 'var(--vscode-editorHoverWidget-foreground)',
    border: '1px solid var(--vscode-editorHoverWidget-border)', borderRadius: '3px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)', color: 'var(--vscode-editorSuggestWidget-foreground)',
    border: '1px solid var(--vscode-editorSuggestWidget-border)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '14em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'bold', color: 'var(--vscode-editorSuggestWidget-highlightForeground)' },
}, { dark: document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast') });

const placeholderSlot = new Compartment();

const editor = new EditorView({
  parent: document.getElementById('editor')!,
  state: EditorState.create({
    doc: '',
    extensions: [
      EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
      inputKeys,
      undoHistory(),
      drawSelection(),
      bracketMatching(),
      octaveLanguage,
      syntaxHighlighting(highlightStyle),
      autocompletion({ override: [completionSource], activateOnTyping: true, icons: true, defaultKeymap: true, maxRenderedOptions: 80 }),
      helpHover,
      placeholderSlot.of(placeholder('Type an Octave command')),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      theme,
      EditorView.contentAttributes.of({ 'aria-label': 'Octave command', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !u.transactions.some(tr => tr.annotation(fromHistory))) { histIndex = -1; }
        if (u.docChanged || u.selectionSet) { scheduleHint(); }
      }),
    ],
  }),
});

// ---- function hint under the input line (usage of the function the cursor is in) ----
let hintTimer: number | undefined;
let hintName = '';
function scheduleHint(): void {
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(updateHint, 250);
}
async function updateHint(): Promise<void> {
  const head = editor.state.selection.main.head;
  const before = editor.state.sliceDoc(0, head);
  const call = canQuery() ? callContext(before) : undefined;
  if (!call) { hintName = ''; hintEl.textContent = ''; return; }
  if (call.name === hintName && hintEl.textContent) { return; }
  hintName = call.name;
  const r = await fetchHelp(call.name);
  if (hintName !== call.name) { return; }
  hintEl.textContent = '';
  if (!r || !r.signatures.length) { return; }
  const sig = document.createElement('span');
  sig.className = 'hint-sig';
  sig.textContent = r.signatures[0] + (r.signatures.length > 1 ? `  (+${r.signatures.length - 1} more)` : '');
  hintEl.append(sig);
  if (r.doc) {
    const d = document.createElement('span');
    d.className = 'hint-doc';
    const first = /^.*?[.!?](?=\s|$)/.exec(r.doc)?.[0] ?? r.doc;
    d.textContent = '  ' + (first.length > 160 ? first.slice(0, 157) + '…' : first);
    hintEl.append(d);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Modes

function setMode(m: InputMode, source?: string): void {
  const wasRunning = mode === 'busy' || mode === 'input';
  mode = m;
  inputSource = source;
  if (m === 'ready' || m === 'debug' || m === 'exited') { finishBlock(); }
  promptEl.textContent = m === 'debug' ? 'K>>' : m === 'more' ? '' : m === 'input' ? '›' : '>>';
  promptEl.className = `mode-${m}`;
  document.body.dataset.mode = m;
  stopEl.hidden = !(m === 'busy' || m === 'input');
  const placeholderText = m === 'busy' ? 'Running… (Enter queues the next command)'
    : m === 'input' ? (source === 'pause' ? 'Paused: press Enter to continue' : 'Octave is waiting for input: type a value and press Enter')
      : m === 'more' ? 'Continue the statement (e.g. end)'
        : m === 'exited' ? 'No Octave session: type a command to start one'
          : m === 'debug' ? 'Paused in the debugger: dbstep, dbcont, dbquit, or any command'
            : 'Type an Octave command';
  editor.dispatch({ effects: placeholderSlot.reconfigure(placeholder(placeholderText)) });
  if (m === 'input' || (wasRunning && m !== 'busy')) {
    if (document.hasFocus()) { editor.focus(); }
  }
  if (!canQuery()) { closeCompletion(editor); hintEl.textContent = ''; }
}

stopEl.addEventListener('click', () => { stop(); editor.focus(); });

// ---------------------------------------------------------------------------------------------------------
// Messages from the extension

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'echo': echo(m.text, m.prompt); break;
    case 'output': output(m.text, m.stream); break;
    case 'info': info(m.text); break;
    case 'echoInput': stdinEcho(m.text); break;
    case 'mode': setMode(m.mode, m.source); break;
    case 'clear': clearOutput(); break;
    case 'history': history = [...m.entries]; break;
    case 'focus': editor.focus(); break;
    case 'completions': case 'help': {
      const v = m.type === 'completions' ? m.items : m.result;
      waiting.get(m.id)?.(v);
      waiting.delete(m.id);
      break;
    }
    case 'test': if (testHooks) { void runTest(m.id, m.action); } break;
  }
});

// ---------------------------------------------------------------------------------------------------------
// Test hooks (integration tests only)

async function runTest(id: number, a: TestAction): Promise<void> {
  let result: unknown = true;
  switch (a.kind) {
    case 'snapshot': result = snapshot(); break;
    case 'type': {
      const end = editor.state.doc.length;
      editor.dispatch({ changes: { from: end, insert: a.text }, selection: { anchor: end + a.text.length }, userEvent: 'input.type' });
      break;
    }
    case 'key': {
      const v = editor;
      const fns: Record<string, () => boolean> = {
        'Enter': () => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : submit(v)),
        'Shift-Enter': () => insertNewlineAndIndent(v),
        'ArrowUp': () => historyMove(v, -1),
        'ArrowDown': () => historyMove(v, 1),
        'Escape': () => { if (completionStatus(v.state)) { return closeCompletion(v); } setInput(v, ''); return true; },
        'Tab': () => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : startCompletion(v)),
        'Ctrl-Space': () => startCompletion(v),
      };
      result = fns[a.key]?.() ?? false;
      break;
    }
    case 'clickLink': {
      const links = outputEl.querySelectorAll('a.link');
      (links[a.index] as HTMLElement | undefined)?.click();
      result = !!links[a.index];
      break;
    }
    case 'toggleCollapse': {
      const btns = outputEl.querySelectorAll('button.toggle');
      (btns[a.index] as HTMLElement | undefined)?.click();
      result = !!btns[a.index];
      break;
    }
    case 'hoverShow': {   // move a synthetic mouse over the word so CodeMirror opens its hover tooltip
      const i = editor.state.doc.toString().indexOf(a.word);
      const c = i >= 0 ? editor.coordsAtPos(i + 1) : null;
      if (c) {
        const ev = { clientX: c.left + 3, clientY: (c.top + c.bottom) / 2, bubbles: true };
        editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', ev));
        setTimeout(() => editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', ev)), 50);
      }
      result = !!c;
      break;
    }
    case 'clickStop':
      result = !stopEl.hidden;
      stopEl.click();
      break;
    case 'hover': {
      const r = await fetchHelp(a.word);
      result = r ? helpDom(r).textContent : null;
      break;
    }
  }
  post({ type: 'testResult', id, result });
}

function snapshot(): Snapshot {
  const links = [...outputEl.querySelectorAll<HTMLAnchorElement>('a.link')].map(a => ({
    text: a.textContent ?? '', file: a.dataset.file, func: a.dataset.func, line: a.dataset.line ? +a.dataset.line : undefined,
  }));
  const classes = new Set<string>();
  editor.contentDOM.querySelectorAll('.cm-line span').forEach(s => s.classList.forEach(c => classes.add(c)));
  return {
    text: outputEl.innerText,
    errorText: [...outputEl.querySelectorAll('.err')].map(e => e.textContent).join(''),
    mode,
    prompt: promptEl.textContent ?? '',
    input: editor.state.doc.toString(),
    links,
    collapsed: outputEl.querySelectorAll('.block.collapsed').length,
    completions: currentCompletions(editor.state).map(c => c.label),
    tooltip: hintEl.textContent ?? '',
    stopVisible: !stopEl.hidden,
    highlighted: [...classes],
  };
}

void inputSource;
post({ type: 'ready' });
editor.focus();
