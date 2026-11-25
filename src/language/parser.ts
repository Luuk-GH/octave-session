import { SECTION_MARKER } from '../sections';

/**
 * A small structural parser for Octave/MATLAB files, shared by the outline, folding and breadcrumbs.
 * It does not build an AST. It finds block keywords (function/if/for/... and their `end`), sections and
 * comments, skipping strings, comments and `end` used as an index (`a(end)`, `c{end}`).
 *
 * Lines and columns are 0-based.
 */

export interface Block {
  /** Opening keyword: function, if, for, while, switch, try, classdef, properties, methods, ... */
  kind: string;
  start: number;
  startCol: number;
  /** Line of the closing keyword, or the last line of the block when it has none (function without end). */
  end: number;
  /** Whether a closing keyword was found. */
  closed: boolean;
  /** Lines of else/elseif/case/otherwise/catch/unwind_protect_cleanup that belong to this block. */
  mids: number[];
  /** Index of the enclosing block in `ParseResult.blocks`, or -1. */
  parent: number;
}

export interface FunctionInfo {
  name: string;
  /** e.g. "[a, b] = name(x, y)" */
  signature: string;
  /** Line/column range of the name. */
  nameLine: number;
  nameCol: number;
  block: Block;
}

export interface SectionInfo {
  /** Marker line. */
  start: number;
  /** Last line of the section: before the next marker, the end of the enclosing function, or the next top-level function. */
  end: number;
  title: string;
}

export interface ParseResult {
  blocks: Block[];
  functions: FunctionInfo[];
  sections: SectionInfo[];
  /** %{ ... %} block comments (marker lines inclusive). */
  blockComments: { start: number; end: number }[];
  /** Runs of two or more consecutive whole-line comments (not section markers). */
  commentRuns: { start: number; end: number }[];
  /** Property / enumeration / event names inside classdef blocks. */
  members: { kind: 'property' | 'event' | 'enum'; name: string; line: number; col: number; block: Block }[];
  /** Whether functions in this file are terminated with `end`. */
  functionsUseEnd: boolean;
}

const OPENERS = new Set(['function', 'if', 'for', 'parfor', 'while', 'switch', 'try', 'unwind_protect', 'do', 'spmd', 'classdef']);
const CLASS_SECTIONS = new Set(['properties', 'methods', 'events', 'enumeration']);
const MIDS = new Set(['else', 'elseif', 'case', 'otherwise', 'catch', 'unwind_protect_cleanup']);
const SPECIFIC_END: Record<string, string> = {
  endfunction: 'function', endif: 'if', endfor: 'for', endparfor: 'parfor', endwhile: 'while', endswitch: 'switch',
  end_try_catch: 'try', end_unwind_protect: 'unwind_protect', until: 'do', endspmd: 'spmd', endclassdef: 'classdef',
  endproperties: 'properties', endmethods: 'methods', endevents: 'events', endenumeration: 'enumeration',
};

const BLOCK_COMMENT_OPEN = /^\s*[%#]\{\s*$/;
const BLOCK_COMMENT_CLOSE = /^\s*[%#]\}\s*$/;

interface Word { text: string; line: number; col: number; depth: number; afterDot: boolean; first: boolean; }

interface LexResult {
  words: Word[];
  blockComments: { start: number; end: number }[];
  commentLines: Set<number>;   // whole-line comments (incl. block comment lines)
  codeLines: Set<number>;      // lines with any code
}

/** Tokenize identifiers outside strings/comments, with bracket depth. */
function lex(lines: readonly string[]): LexResult {
  const words: Word[] = [];
  const blockComments: { start: number; end: number }[] = [];
  const commentLines = new Set<number>();
  const codeLines = new Set<number>();
  let blockDepth = 0;
  let blockStart = 0;
  let brackets: string[] = [];

  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    if (blockDepth > 0) {
      commentLines.add(ln);
      if (BLOCK_COMMENT_OPEN.test(s)) { blockDepth++; }
      else if (BLOCK_COMMENT_CLOSE.test(s) && --blockDepth === 0) { blockComments.push({ start: blockStart, end: ln }); }
      continue;
    }
    if (BLOCK_COMMENT_OPEN.test(s)) { blockDepth = 1; blockStart = ln; commentLines.add(ln); continue; }

    let i = 0;
    let continued = false;
    let first = true;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '%' || c === '#') {
        if (first) { commentLines.add(ln); }
        break;
      }
      if (c === '.' && s.startsWith('...', i)) { continued = true; break; }
      codeLines.add(ln);
      const prev = i > 0 ? s[i - 1] : '';
      if (c === "'") {
        if (/[\w)\]}'.]/.test(prev)) { i++; first = false; continue; }  // transpose
        i++;
        while (i < n) {
          if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
          i++;
        }
        first = false;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n) {
          if (s[i] === '\\') { i += 2; continue; }
          if (s[i] === '"') { if (s[i + 1] === '"') { i += 2; continue; } i++; break; }
          i++;
        }
        first = false;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { brackets.push(c); i++; first = false; continue; }
      if (c === ')' || c === ']' || c === '}') { brackets.pop(); i++; first = false; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < n && /\w/.test(s[j])) { j++; }
        const text = s.slice(i, j);
        // A line starting with function/classdef can't be inside brackets: recover from unbalanced ones.
        if (first && (text === 'function' || text === 'classdef')) { brackets = []; }
        let k = i - 1;
        while (k >= 0 && (s[k] === ' ' || s[k] === '\t')) { k--; }
        const afterDot = k >= 0 && s[k] === '.' && !(k > 0 && /\d/.test(s[k - 1]) && !/\w/.test(s[k - 2] ?? ''));
        words.push({ text, line: ln, col: i, depth: brackets.length, afterDot, first });
        i = j;
        first = false;
        continue;
      }
      if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1] ?? ''))) {
        const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eEdD][+-]?\d+)?)[ij]?/.exec(s.slice(i));
        i += m ? m[0].length : 1;
        first = false;
        continue;
      }
      i++;
      first = false;
    }
    // Parentheses don't continue over a line break without "..."; [] and {} do (matrix rows).
    if (!continued) { brackets = brackets.filter(b => b !== '('); }
  }
  if (blockDepth > 0) { blockComments.push({ start: blockStart, end: lines.length - 1 }); }
  return { words, blockComments, commentLines, codeLines };
}

function buildBlocks(words: Word[], lineCount: number, functionsUseEnd: boolean, lastCodeLineBefore: (l: number) => number) {
  const blocks: Block[] = [];
  const stack: number[] = [];
  let strayClosers = 0;
  const top = () => (stack.length ? blocks[stack[stack.length - 1]] : undefined);
  const close = (endLine: number, closed: boolean) => {
    const b = blocks[stack.pop()!];
    b.end = endLine;
    b.closed = closed;
  };

  for (const w of words) {
    if (w.depth > 0 || w.afterDot) { continue; }
    const t = w.text;
    const cur = top();
    const isOpener = OPENERS.has(t) || (CLASS_SECTIONS.has(t) && cur?.kind === 'classdef');
    if (isOpener) {
      if (t === 'function' && !functionsUseEnd) {
        // Functions without `end`: a new function ends the previous one (at any nesting left open).
        while (stack.length && blocks[stack[stack.length - 1]].kind !== 'classdef') {
          const b = top()!;
          if (b.kind !== 'function') { close(lastCodeLineBefore(w.line), false); continue; }
          close(lastCodeLineBefore(w.line), false);
          break;
        }
      }
      blocks.push({ kind: t, start: w.line, startCol: w.col, end: -1, closed: false, mids: [], parent: stack.length ? stack[stack.length - 1] : -1 });
      stack.push(blocks.length - 1);
      continue;
    }
    if (MIDS.has(t)) {
      if (cur && cur.kind !== 'function' && cur.kind !== 'classdef') { cur.mids.push(w.line); }
      continue;
    }
    if (t === 'end' || t in SPECIFIC_END) {
      if (!stack.length) { strayClosers++; continue; }
      if (t !== 'end') {
        // Close up to the matching kind (tolerates missing ends inside).
        const want = SPECIFIC_END[t];
        const idx = [...stack].reverse().findIndex(i => blocks[i].kind === want);
        if (idx === -1) { strayClosers++; continue; }
        for (let k = 0; k < idx; k++) { close(w.line, false); }
      }
      close(w.line, true);
    }
  }
  const last = lastCodeLineBefore(lineCount);
  while (stack.length) { close(Math.max(top()!.start, last), false); }
  return { blocks, strayClosers };
}

/** Parse a document given as lines. */
export function parse(lines: readonly string[]): ParseResult {
  const lex0 = lex(lines);
  const lastCodeLineBefore = (l: number) => {
    let k = Math.min(l, lines.length) - 1;
    while (k > 0 && !lex0.codeLines.has(k) && !lex0.commentLines.has(k)) { k--; }
    return Math.max(k, 0);
  };

  // Do this file's functions end with `end`? Try that first; if functions are left open, they don't.
  let { blocks, strayClosers } = buildBlocks(lex0.words, lines.length, true, lastCodeLineBefore);
  let functionsUseEnd = true;
  const hasFunctions = blocks.some(b => b.kind === 'function');
  if (hasFunctions && blocks.some(b => !b.closed) && strayClosers === 0) {
    const alt = buildBlocks(lex0.words, lines.length, false, lastCodeLineBefore);
    blocks = alt.blocks;
    functionsUseEnd = false;
  }

  const functions: FunctionInfo[] = [];
  for (const b of blocks) {
    if (b.kind !== 'function') { continue; }
    const info = parseSignature(lines, b);
    if (info) { functions.push(info); }
  }

  // Sections end at the next marker, the end of the enclosing function, or the next top-level function.
  const markers: number[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    if (SECTION_MARKER.test(lines[ln]) && !inBlockComment(lex0.blockComments, ln)) { markers.push(ln); }
  }
  const funcBlocks = blocks.filter(b => b.kind === 'function');
  const sections: SectionInfo[] = markers.map((start, i) => {
    let end = i + 1 < markers.length ? markers[i + 1] - 1 : lines.length - 1;
    const encl = funcBlocks.filter(b => b.start < start && b.end >= start).sort((a, b) => b.start - a.start)[0];
    if (encl) {
      end = Math.min(end, encl.closed ? encl.end - 1 : encl.end);
    } else {
      const next = funcBlocks.find(b => b.start > start && b.parent === -1);
      if (next) { end = Math.min(end, next.start - 1); }
    }
    while (end > start && !lines[end].trim()) { end--; }
    return { start, end: Math.max(start, end), title: lines[start].replace(SECTION_MARKER, '').trim() };
  });

  const commentRuns: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let ln = 0; ln <= lines.length; ln++) {
    const isLineComment = ln < lines.length && lex0.commentLines.has(ln) && !SECTION_MARKER.test(lines[ln])
      && !inBlockComment(lex0.blockComments, ln);
    if (isLineComment) { if (runStart < 0) { runStart = ln; } continue; }
    if (runStart >= 0 && ln - 1 > runStart) { commentRuns.push({ start: runStart, end: ln - 1 }); }
    runStart = -1;
  }

  return { blocks, functions, sections, blockComments: lex0.blockComments, commentRuns,
           members: classMembers(lex0.words, blocks), functionsUseEnd };
}

function inBlockComment(bc: { start: number; end: number }[], ln: number): boolean {
  return bc.some(b => ln >= b.start && ln <= b.end);
}

const SIG = /^(\s*function\s+)(?:(\[[^\]]*\]|[A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)\s*(\([^)]*\)?)?/;

function parseSignature(lines: readonly string[], b: Block): FunctionInfo | undefined {
  // Join continuation lines of the declaration.
  let text = lines[b.start].slice(0);
  let ln = b.start;
  while (/\.\.\.[^'"]*$/.test(text) && ln + 1 < lines.length) {
    text = text.replace(/\.\.\..*$/, ' ') + lines[++ln].trim();
  }
  text = text.replace(/[%#].*$/, '');
  const prefix = ' '.repeat(b.startCol);
  const m = SIG.exec(prefix + text.slice(b.startCol));
  if (!m) { return undefined; }
  const outputs = m[2] ? m[2].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\[\s*/, '[').replace(/\s*\]/, ']') : '';
  const args = m[4] ? (m[4].endsWith(')') ? m[4] : m[4] + ')').replace(/\s*,\s*/g, ', ') : '';
  const name = m[3];
  const signature = `${outputs ? outputs + ' = ' : ''}${name}${args}`;
  const nameIdx = lines[b.start].indexOf(name, b.startCol + 8);
  return { name, signature, nameLine: b.start, nameCol: nameIdx >= 0 ? nameIdx : b.startCol, block: b };
}

function classMembers(words: Word[], blocks: Block[]): ParseResult['members'] {
  const out: ParseResult['members'] = [];
  for (const b of blocks) {
    if (!['properties', 'events', 'enumeration'].includes(b.kind)) { continue; }
    const kind = b.kind === 'properties' ? 'property' : b.kind === 'events' ? 'event' : 'enum';
    for (const w of words) {
      if (w.line <= b.start || w.line >= b.end || !w.first || w.depth > 0) { continue; }
      // Only direct children: skip words inside nested blocks (none expected) and keyword lines.
      if (w.text === 'end' || SPECIFIC_END[w.text]) { continue; }
      out.push({ kind, name: w.text, line: w.line, col: w.col, block: b });
    }
  }
  return out;
}
