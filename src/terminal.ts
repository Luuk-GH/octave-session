import * as vscode from 'vscode';
import { ConsoleView } from './consoleView';
import { callContext, completionPrefix } from './language/signatures';

const PROMPT = '>> ';
const DEBUG_PROMPT = 'K>> ';
const MORE_PROMPT = '   ';
const DIM = '\x1b[2m', RED = '\x1b[31m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
/** "called from" lines for the extension's own helper functions (e.g. __vsc_run__) are hidden. */
const HELPER_FRAME = /^\s+__vsc_\w+__ at line \d+(?: column \d+)?\r?\n?$/;
/** Octave's debugger location message on stderr; it is followed by a "N: code" line. */
const STOP_LINE = /^stopped in .* at line \d+/;

export interface TerminalHost {
  /** A line the user typed and submitted with Enter. */
  onUserLine(line: string): void;
  /** A line typed while Octave waited for input (input, yes_or_no, pause): goes to stdin. */
  onInputLine(line: string): void;
  /** Ctrl+C pressed while Octave is busy. */
  onInterrupt(): void;
  /** The terminal was closed by the user. */
  onClose(): void;
  /** The terminal is open and ready to show output. */
  onOpen(): void;
  /** Tab completion: full (possibly dotted) names that start with `prefix`, or undefined if unavailable. */
  onComplete?(prefix: string): Promise<string[] | undefined>;
  /** Tab inside a call: usage lines of function `name`, or undefined if unknown. */
  onUsage?(name: string): Promise<string[] | undefined>;
}

/** Above this many candidates, Tab asks before listing them (like bash). */
const LIST_ASK_THRESHOLD = 100;

/**
 * The "Command Window": a Pseudoterminal with a small line editor (cursor keys, history, paste).
 * Octave runs on plain pipes (no line editing); this class owns prompt rendering and input.
 */
export class OctaveTerminal implements vscode.Pseudoterminal, ConsoleView {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private line = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;    // -1 = editing a new line
  private savedLine = '';       // new-line draft while browsing history
  private inputEnabled = false; // a prompt is shown and the line editor is live
  private promptText = PROMPT;
  private basePrompt = PROMPT;  // '>> ' at top level, 'K>> ' while stopped in the debugger
  private skipCodeLine = false; // the next stderr line is the code line of a hidden stop message
  private typeahead = '';       // keystrokes received while Octave was busy
  private atLineStart = true;   // whether the last output ended with a newline
  private partialLine = '';     // output written since the last newline (an input() prompt, for example)
  private stdinMode = false;    // the line editor answers input()/yes_or_no/pause instead of running a command
  private opened = false;
  private pendingWrites: string[] = [];
  private columns = 80;
  private pendingList: string[] | undefined;  // candidates waiting for the "Display all N possibilities?" answer
  private recent = '';

  constructor(private readonly host: TerminalHost) {}

  // ---- vscode.Pseudoterminal ----
  open(): void {
    this.opened = true;
    for (const w of this.pendingWrites.splice(0)) { this.writeEmitter.fire(w); }
    this.host.onOpen();
  }

  close(): void { this.host.onClose(); }

  setDimensions(dim: vscode.TerminalDimensions): void { this.columns = dim.columns; }

  handleInput(data: string): void {
    if (!this.inputEnabled || (this.stdinMode && data === '\x03')) {
      if (data === '\x03') { this.host.onInterrupt(); return; }
      this.typeahead += data;
      return;
    }
    this.processKeys(data);
  }

  // ---- API for the session manager ----

  /** Print Octave output. Keeps any half-typed input line intact below the output. */
  writeOutput(text: string, stream: 'out' | 'err'): void {
    if (!text) { return; }
    let body = text;
    if (stream === 'err') {
      body = text.split(/(?<=\n)/).filter(seg => {
        if (HELPER_FRAME.test(seg)) { return false; }
        // Debugger location ("stopped in f at line 3 [file]" + "3: code"): the editor already shows it.
        if (STOP_LINE.test(seg)) { this.skipCodeLine = true; return false; }
        if (this.skipCodeLine) {
          this.skipCodeLine = false;
          if (/^\d+: /.test(seg)) { return false; }
        }
        return true;
      }).map(seg => {
        const color = /^\s*warning:/.test(seg) ? YELLOW : RED;
        return seg.endsWith('\n') ? color + seg.slice(0, -1) + RESET + '\n' : color + seg + RESET;
      }).join('');
      if (!body) { return; }
    }
    if (this.inputEnabled) { this.write('\r\x1b[K'); this.atLineStart = true; }
    this.write(toCrlf(body));
    this.atLineStart = text.endsWith('\n');
    const nl = body.lastIndexOf('\n');
    this.partialLine = nl === -1 ? this.partialLine + body : body.slice(nl + 1);
    if (this.inputEnabled) { this.ensureNewline(); this.redrawLine(); }
  }

  /** Show `>> code` for a command the extension runs on the user's behalf (Run File etc.). */
  echoCommand(display: string): void {
    if (this.inputEnabled) { this.write('\r\x1b[K'); }
    else { this.ensureNewline(); }
    const lines = display.split(/\r?\n/);
    const prompt = this.basePrompt;
    this.write(prompt + DIM + lines.join('\r\n' + ' '.repeat(prompt.length)) + RESET + '\r\n');
    this.atLineStart = true;
    this.partialLine = '';
    this.inputEnabled = false;
    this.stdinMode = false;
  }

  /** Octave is waiting for input: show a prompt and re-enable the line editor. */
  showPrompt(kind: 'ready' | 'more' | 'debug'): void {
    const base = kind === 'more' ? this.basePrompt : kind === 'debug' ? DEBUG_PROMPT : PROMPT;
    const text = kind === 'more' ? MORE_PROMPT : base;
    if (this.inputEnabled && this.promptText === text) { return; }  // already showing it (e.g. after a hidden query)
    this.ensureNewline();
    this.basePrompt = base;
    this.promptText = text;
    this.inputEnabled = true;
    this.stdinMode = false;
    this.redrawLine();
    if (this.typeahead) {
      const t = this.typeahead;
      this.typeahead = '';
      this.processKeys(t);
    }
  }

  /** Disable input (Octave busy). */
  setBusy(): void {
    if (this.inputEnabled) { this.inputEnabled = false; }
    this.stdinMode = false;
  }

  /** The running command reads a line (input() etc.): the line editor answers it, after Octave's own prompt. */
  requestInput(_source: string): void {
    this.promptText = this.partialLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    this.atLineStart = !this.promptText;
    this.inputEnabled = true;
    this.stdinMode = true;
    this.redrawLine();
    if (this.typeahead) {
      const t = this.typeahead;
      this.typeahead = '';
      this.processKeys(t);
    }
  }

  /** Input typed in another view: show it after the prompt, as if typed here. */
  echoInput(text: string): void {
    this.writeOutput(text + '\n', 'out');
  }

  /** clc / home: clear the screen (the input line, if shown, is redrawn). */
  clearScreen(): void {
    this.write(CLEAR_SCREEN);
    this.atLineStart = true;
    this.partialLine = '';
    if (this.inputEnabled) { this.redrawLine(); }
  }

  /** Print an informational line (dim), e.g. session start/exit notices. */
  info(text: string): void {
    if (this.inputEnabled) { this.write('\r\x1b[K'); } else { this.ensureNewline(); }
    this.write(DIM + toCrlf(text) + RESET + '\r\n');
    this.atLineStart = true;
    this.partialLine = '';
    if (this.inputEnabled) { this.redrawLine(); }
  }

  /** Forget the input state (used after the Octave process has gone away). */
  resetInput(): void {
    this.inputEnabled = false;
    this.stdinMode = false;
    this.basePrompt = PROMPT;
    this.typeahead = '';
  }

  dispose(): void {
    this.closeEmitter.fire();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  // ---- line editor ----

  private processKeys(data: string): void {
    let i = 0;
    while (i < data.length) {
      if (!this.inputEnabled) { this.typeahead += data.slice(i); return; }
      if (this.pendingList) { this.answerList(data[i++]); continue; }
      const rest = data.slice(i);
      const esc = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
      if (esc) { this.handleEscape(esc[0]); i += esc[0].length; continue; }
      const ch = data[i++];
      switch (ch) {
        case '\r':
          if (data[i] === '\n') { i++; }
          this.submit();
          break;
        case '\n': this.submit(); break;
        case '\x7f': case '\b':
          if (this.cursor > 0) {
            this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
            this.cursor--; this.redrawLine();
          }
          break;
        case '\x03': // Ctrl+C at the prompt: discard the line
          this.write('^C\r\n');
          this.line = ''; this.cursor = 0; this.historyIndex = -1;
          this.promptText = this.basePrompt;
          this.redrawLine();
          break;
        case '\x01': this.cursor = 0; this.redrawLine(); break;                   // Ctrl+A
        case '\x05': this.cursor = this.line.length; this.redrawLine(); break;    // Ctrl+E
        case '\x15': this.line = this.line.slice(this.cursor); this.cursor = 0; this.redrawLine(); break; // Ctrl+U
        case '\x0b': this.line = this.line.slice(0, this.cursor); this.redrawLine(); break;              // Ctrl+K
        case '\x0c': this.write('\x1b[2J\x1b[H'); this.redrawLine(); break;        // Ctrl+L
        case '\t': {
          if (this.stdinMode) { this.insert('    '); break; }
          const before = this.line.slice(0, this.cursor);
          const cp = completionPrefix(before);
          const call = cp?.prefix ? undefined : callContext(before);
          if (cp?.prefix && this.host.onComplete) { void this.complete(cp.prefix); }
          else if (call && this.host.onUsage) { void this.showUsage(call.name); }
          else { this.insert('    '); }
          break;
        }
        default:
          if (ch >= ' ' || ch > '\x7f') { this.insert(ch); }
      }
    }
  }

  /** Tab completion: complete a unique match or the common start, otherwise list the candidates. */
  private async complete(prefix: string): Promise<void> {
    const before = { line: this.line, cursor: this.cursor };
    const names = await this.host.onComplete!(prefix);
    // Ignore the answer if the user kept typing or Octave started running something.
    if (!this.inputEnabled || this.line !== before.line || this.cursor !== before.cursor) { return; }
    const matches = [...new Set((names ?? []).filter(n => n.startsWith(prefix)))].sort();
    if (!matches.length) { this.write('\x07'); return; }
    let common = matches[0];
    for (const m of matches) {
      let i = 0;
      while (i < common.length && i < m.length && common[i] === m[i]) { i++; }
      common = common.slice(0, i);
    }
    if (common.length > prefix.length) {
      this.insert(common.slice(prefix.length));
      return;
    }
    if (matches.length === 1) { return; }
    // Several candidates and nothing to add: list them (last name segment) in columns under the prompt.
    const labels = matches.map(m => m.slice(m.lastIndexOf('.') + 1));
    if (labels.length > LIST_ASK_THRESHOLD) {
      this.pendingList = labels;
      this.write('\r\x1b[K' + this.promptText + this.line + `\r\nDisplay all ${labels.length} possibilities? (y or n)`);
      this.atLineStart = false;
      return;
    }
    this.printBelow(columnize(labels, this.columns));
  }

  /** Answer to "Display all N possibilities?": any key other than y/Y cancels. */
  private answerList(key: string): void {
    const labels = this.pendingList!;
    this.pendingList = undefined;
    this.write('\r\n');
    this.atLineStart = true;
    if (key === 'y' || key === 'Y') { this.write(columnize(labels, this.columns).join('\r\n') + '\r\n'); }
    this.redrawLine();
  }

  /** Tab inside a call: print the function's usage forms and a short description under the prompt. */
  private async showUsage(name: string): Promise<void> {
    const before = { line: this.line, cursor: this.cursor };
    const lines = await this.host.onUsage!(name);
    if (!this.inputEnabled || this.line !== before.line || this.cursor !== before.cursor) { return; }
    if (!lines?.length) { this.write('\x07'); return; }
    this.printBelow(lines.map(l => DIM + l + RESET));
  }

  /** Print lines below the current input line, then redraw the prompt and input. */
  private printBelow(lines: string[]): void {
    this.write('\r\x1b[K' + this.promptText + this.line + '\r\n' + lines.join('\r\n') + '\r\n');
    this.atLineStart = true;
    this.redrawLine();
  }

  private insert(s: string): void {
    this.line = this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor);
    this.cursor += s.length;
    this.redrawLine();
  }

  private handleEscape(seq: string): void {
    switch (seq) {
      case '\x1b[A': case '\x1bOA': this.historyMove(-1); break;
      case '\x1b[B': case '\x1bOB': this.historyMove(1); break;
      case '\x1b[C': case '\x1bOC': if (this.cursor < this.line.length) { this.cursor++; this.redrawLine(); } break;
      case '\x1b[D': case '\x1bOD': if (this.cursor > 0) { this.cursor--; this.redrawLine(); } break;
      case '\x1b[H': case '\x1bOH': case '\x1b[1~': this.cursor = 0; this.redrawLine(); break;
      case '\x1b[F': case '\x1bOF': case '\x1b[4~': this.cursor = this.line.length; this.redrawLine(); break;
      case '\x1b[3~':
        if (this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
          this.redrawLine();
        }
        break;
      case '\x1b[1;5D': { // Ctrl+Left: previous word
        const m = /\S+\s*$/.exec(this.line.slice(0, this.cursor));
        this.cursor = m ? m.index : 0; this.redrawLine(); break;
      }
      case '\x1b[1;5C': { // Ctrl+Right: next word
        const m = /^\s*\S+/.exec(this.line.slice(this.cursor));
        this.cursor += m ? m[0].length : 0; this.redrawLine(); break;
      }
    }
  }

  private historyMove(delta: number): void {
    if (!this.history.length || this.stdinMode) { return; }
    // MATLAB-style: Up with a typed prefix only cycles through matching entries.
    const prefix = this.historyIndex === -1 ? this.line : this.savedLine;
    let idx = this.historyIndex;
    if (idx === -1) { if (delta > 0) { return; } this.savedLine = this.line; idx = this.history.length; }
    for (;;) {
      idx += delta;
      if (idx < 0) { return; }
      if (idx >= this.history.length) {
        this.historyIndex = -1; this.line = this.savedLine; break;
      }
      if (this.history[idx].startsWith(prefix)) { this.historyIndex = idx; this.line = this.history[idx]; break; }
    }
    this.cursor = this.line.length;
    this.redrawLine();
  }

  private submit(): void {
    const line = this.line;
    this.write('\r\n');
    this.atLineStart = true;
    this.partialLine = '';
    if (this.stdinMode) {
      this.line = ''; this.cursor = 0;
      this.inputEnabled = false;
      this.stdinMode = false;
      this.host.onInputLine(line);
      return;
    }
    if (line.trim() && this.history[this.history.length - 1] !== line) { this.history.push(line); }
    if (this.history.length > 1000) { this.history.shift(); }
    this.line = ''; this.cursor = 0; this.historyIndex = -1; this.savedLine = '';
    this.inputEnabled = false;
    this.host.onUserLine(line);
  }

  private redrawLine(): void {
    if (!this.inputEnabled) { return; }
    const back = this.line.length - this.cursor;
    this.write('\r\x1b[K' + this.promptText + this.line + (back ? `\x1b[${back}D` : ''));
    this.atLineStart = false;
  }

  private ensureNewline(): void {
    if (!this.atLineStart) { this.write('\r\n'); this.atLineStart = true; }
  }

  private write(s: string): void {
    this.recent = (this.recent + s).slice(-16000);
    if (this.opened) { this.writeEmitter.fire(s); } else { this.pendingWrites.push(s); }
  }

  /** The last ~16 KB written to the terminal, without escape sequences (for tests and diagnostics). */
  recentText(): string {
    return this.recent.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x07/g, '');
  }
}

/** Lay out names in columns that fit the terminal width. */
function columnize(labels: string[], columns: number): string[] {
  const width = Math.max(...labels.map(l => l.length)) + 2;
  const perRow = Math.max(1, Math.floor(Math.max(columns - 1, width) / width));
  const rows: string[] = [];
  for (let i = 0; i < labels.length; i += perRow) {
    rows.push(labels.slice(i, i + perRow).map(l => l.padEnd(width)).join('').trimEnd());
  }
  return rows;
}

function toCrlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}
