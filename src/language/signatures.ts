/**
 * Pure helpers for completion and signature help (no VS Code dependency, unit-tested).
 */

export interface Signature {
  /** e.g. "x = zeros (m, n, ...)" */
  label: string;
  /** [start, end) offsets of each parameter in `label`. */
  params: [number, number][];
}

/** Turn Texinfo markup from Octave help text into plain text. */
export function cleanTexinfo(s: string): string {
  let t = s.replace(/@dots\{\}/g, '...').replace(/@(?:result|print|error|expansion|equiv|point)\{\}/g, '');
  // @cmd{content} -> content, innermost first, until nothing changes.
  for (let i = 0; i < 5; i++) {
    const next = t.replace(/@[a-zA-Z]+\{([^{}]*)\}/g, '$1');
    if (next === t) { break; }
    t = next;
  }
  return t.replace(/@(noindent|group|end\s+\w+|cindex.*|tex.*)\b/g, '').replace(/@([@{}])/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

/** Read a {braced group} at `i` (after whitespace). Returns its raw content and the index after it. */
function bracedGroup(s: string, i: number): { text: string; next: number } | undefined {
  while (s[i] === ' ' || s[i] === '\t') { i++; }
  if (s[i] !== '{') { return undefined; }
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '@' && j + 1 < s.length) { j++; continue; }  // escaped char or @cmd start
    if (s[j] === '{') { depth++; }
    else if (s[j] === '}' && --depth === 0) { return { text: s.slice(i + 1, j), next: j + 1 }; }
  }
  return undefined;
}

/** Parse a Texinfo "@deftypefn {category} {outputs =} name (args)" line. */
export function parseDeftypefn(line: string): Signature | undefined {
  const m = /^\s*@deftypefnx?\s+/.exec(line);
  if (!m) { return undefined; }
  const cat = bracedGroup(line, m[0].length);
  if (!cat) { return undefined; }
  const ret = bracedGroup(line, cat.next);
  if (!ret) { return undefined; }
  const outputs = cleanTexinfo(ret.text);
  const rest = cleanTexinfo(line.slice(ret.next));
  if (!rest) { return undefined; }
  return withParams(`${outputs ? outputs + ' ' : ''}${rest}`);
}

/** Signature from a function declaration as printed by the parser, e.g. "[a, b] = name(x, y)". */
export function signatureFromDeclaration(decl: string): Signature {
  return withParams(decl);
}

/** Locate parameters inside the last top-level (...) of a label. */
function withParams(label: string): Signature {
  const open = findArgsOpen(label);
  if (open < 0) { return { label, params: [] }; }
  const params: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < label.length; i++) {
    const c = label[i];
    if (c === '(' || c === '[' || c === '{') { depth++; }
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) { depth--; }
    else if (c === ')' || (c === ',' && depth === 0)) {
      let a = start, b = i;
      while (a < b && label[a] === ' ') { a++; }
      while (b > a && label[b - 1] === ' ') { b--; }
      if (b > a) { params.push([a, b]); }
      start = i + 1;
      if (c === ')') { break; }
    }
  }
  return { label, params };
}

/** Index of the "(" that opens the argument list: the first one after the function name. */
function findArgsOpen(label: string): number {
  const eq = label.indexOf('=');
  const from = eq >= 0 && eq < label.indexOf('(') ? eq + 1 : 0;
  return label.indexOf('(', from);
}

export interface CallContext {
  /** Function name before the innermost open parenthesis. */
  name: string;
  /** 0-based index of the argument the cursor is in. */
  param: number;
}

const KEYWORDS = new Set(['if', 'elseif', 'while', 'for', 'parfor', 'switch', 'case', 'until', 'return', 'function', 'end']);

/**
 * Find the call the cursor is in. `text` is the code before the cursor (continuation lines joined
 * by the caller). Strings and comments are skipped; brackets nest.
 */
export function callContext(text: string): CallContext | undefined {
  interface Open { ch: string; pos: number; commas: number; }
  const stack: Open[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (c === '%' || c === '#') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { return undefined; }  // cursor is in a comment
      i = nl + 1;
      continue;
    }
    if (c === "'" && !/[\w)\]}'.]/.test(prev)) {
      const end = closeQuote(text, i + 1, "'");
      if (end < 0) { return undefined; }  // cursor is in a string
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = closeQuote(text, i + 1, '"');
      if (end < 0) { return undefined; }
      i = end + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { stack.push({ ch: c, pos: i, commas: 0 }); }
    else if (c === ')' || c === ']' || c === '}') { stack.pop(); }
    else if (c === ',' && stack.length) { stack[stack.length - 1].commas++; }
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const o = stack[k];
    if (o.ch !== '(') { return undefined; }  // inside [] or {} of an argument: no hint
    const m = /(?:^|[^\w.])([A-Za-z_]\w*)\s*$/.exec(text.slice(0, o.pos));
    if (m && !KEYWORDS.has(m[1])) { return { name: m[1], param: o.commas }; }
    return undefined;
  }
  return undefined;
}

function closeQuote(s: string, i: number, q: string): number {
  while (i < s.length) {
    if (s[i] === '\n') { return i; }
    if (q === '"' && s[i] === '\\') { i += 2; continue; }
    if (s[i] === q) { if (s[i + 1] === q) { i += 2; continue; } return i; }
    i++;
  }
  return -1;
}

export interface CompletionPrefix {
  /** Full dotted prefix, e.g. "s.na" or "pl" (may be ""). */
  prefix: string;
  /** Column where the last segment (the part being replaced) starts. */
  segmentStart: number;
}

/** The identifier (possibly dotted) being typed at the end of `linePrefix`; undefined in strings/comments/numbers. */
export function completionPrefix(linePrefix: string): CompletionPrefix | undefined {
  // Reuse the call scanner's string/comment logic: any unterminated string or comment means "no completion".
  if (inStringOrComment(linePrefix)) { return undefined; }
  const m = /(?:^|[^\w.])((?:[A-Za-z_]\w*\.)*[A-Za-z_]?\w*)$/.exec(linePrefix);
  if (!m) { return undefined; }
  const prefix = m[1];
  if (/^\d/.test(prefix)) { return undefined; }
  const lastDot = prefix.lastIndexOf('.');
  return { prefix, segmentStart: linePrefix.length - prefix.length + lastDot + 1 };
}

function inStringOrComment(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    if (c === '%' || c === '#') { return true; }
    if ((c === "'" && !/[\w)\]}'.]/.test(prev)) || c === '"') {
      const end = closeQuote(s, i + 1, c);
      if (end < 0) { return true; }
      i = end + 1;
      continue;
    }
    i++;
  }
  return false;
}
