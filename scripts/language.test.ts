// Unit checks for the structural parser and the TextMate grammar. Run: npm run test:unit
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { parse } from '../src/language/parser';
import { callContext, cleanTexinfo, completionPrefix, parseDeftypefn, signatureFromDeclaration } from '../src/language/signatures';

const root = path.join(__dirname, '..');
const fnSummary = (r: ReturnType<typeof parse>) =>
  r.functions.map(f => `${f.name} ${f.block.start}-${f.block.end}${f.block.parent >= 0 ? ' in ' + r.blocks[f.block.parent].kind : ''}`);

// ---- script with sections and local functions without `end` ----
{
  const r = parse([
    '%% Setup',                    // 0
    'x = [1 2 3];',                // 1
    'y = x(end);',                 // 2
    '%% Loop',                     // 3
    'for k = 1:3',                 // 4
    '  if k > 1',                  // 5
    '    disp(k)',                 // 6
    '  else',                      // 7
    "    s = 'end'; t = x';",      // 8  string and transpose
    '  end',                       // 9
    'end',                         // 10
    "r = helper(x)';",             // 11
    '',                            // 12
    'function out = helper(v)',    // 13
    '  out = v * 2;',              // 14
    '',                            // 15
    'function [a, b] = other(p, q)', // 16
    '  a = p; b = q;',             // 17
  ]);
  assert.strictEqual(r.functionsUseEnd, false);
  assert.deepStrictEqual(fnSummary(r), ['helper 13-14', 'other 16-17']);
  assert.deepStrictEqual(r.functions.map(f => f.signature), ['out = helper(v)', '[a, b] = other(p, q)']);
  assert.deepStrictEqual(r.sections, [{ start: 0, end: 2, title: 'Setup' }, { start: 3, end: 11, title: 'Loop' }]);
  const loop = r.blocks.find(b => b.kind === 'for')!;
  const cond = r.blocks.find(b => b.kind === 'if')!;
  assert.deepStrictEqual([loop.start, loop.end, loop.closed], [4, 10, true]);
  assert.deepStrictEqual([cond.start, cond.end, cond.mids], [5, 9, [7]]);
}

// ---- function file with end, nested function, block comment, fields and indexing ----
{
  const r = parse([
    'function r = main(a)',        // 0
    '  %{',                        // 1
    '  if this were code end',     // 2
    '  %}',                        // 3
    '  s.end = 1; s.if = 2;',      // 4
    '  c = {1, 2};',               // 5
    '  z = c{end} + c{end-1};',    // 6
    '  m = [1 2',                  // 7
    '       3 numel(c(end))];',    // 8
    '  r = nested(a); % end',      // 9
    '  function y = nested(b)',    // 10
    '    y = b + 1;',              // 11
    '  end',                       // 12
    'end',                         // 13
    'function q = sub ()',         // 14
    '  q = "it\'s # not a comment end";', // 15
    '  x = 1; ...  end',           // 16
    'endfunction',                 // 17
  ]);
  assert.strictEqual(r.functionsUseEnd, true);
  assert.deepStrictEqual(fnSummary(r), ['main 0-13', 'nested 10-12 in function', 'sub 14-17']);
  assert.deepStrictEqual(r.blockComments, [{ start: 1, end: 3 }]);
  assert.deepStrictEqual(r.blocks.map(b => b.kind), ['function', 'function', 'function']);
  assert.strictEqual(r.functions[2].signature, 'q = sub()');
}

// ---- classdef ----
{
  const r = parse([
    'classdef Point < handle',     // 0
    '  properties (Access = public)', // 1
    '    X = 0;',                  // 2
    '    Y   % the y coordinate',  // 3
    '  end',                       // 4
    '  methods',                   // 5
    '    function obj = Point(x)', // 6
    '      obj.X = x;',            // 7
    '    end',                     // 8
    '    function d = norm(obj)',  // 9
    '      d = abs(obj.X);',       // 10
    '    end',                     // 11
    '  end',                       // 12
    'end',                         // 13
  ]);
  assert.deepStrictEqual(fnSummary(r), ['Point 6-8 in methods', 'norm 9-11 in methods']);
  assert.deepStrictEqual(r.members.map(m => `${m.kind} ${m.name} ${m.line}`), ['property X 2', 'property Y 3']);
  const cls = r.blocks.find(b => b.kind === 'classdef')!;
  assert.deepStrictEqual([cls.start, cls.end, cls.closed], [0, 13, true]);
}

// ---- Octave-specific blocks, one-liners, comment runs ----
{
  const r = parse([
    '% Help text line 1',          // 0
    '# help text line 2',          // 1
    'do',                          // 2
    '  i++;',                      // 3
    'until i > 3',                 // 4
    'unwind_protect',              // 5
    '  x = 1;',                    // 6
    'unwind_protect_cleanup',      // 7
    '  y = 2;',                    // 8
    'end_unwind_protect',          // 9
    'switch x',                    // 10
    '  case 1',                    // 11
    '    a = 1;',                  // 12
    '  otherwise',                 // 13
    '    a = 2;',                  // 14
    'endswitch',                   // 15
    'if a, b = 1; end',            // 16
    'try, error("x"), catch err, disp(err.message), end_try_catch', // 17
    'while false',                 // 18
    'endwhile',                    // 19
  ]);
  const summary = r.blocks.map(b => `${b.kind} ${b.start}-${b.end}${b.mids.length ? ' [' + b.mids + ']' : ''}`);
  assert.deepStrictEqual(summary, ['do 2-4', 'unwind_protect 5-9 [7]', 'switch 10-15 [11,13]', 'if 16-16', 'try 17-17 [17]', 'while 18-19']);
  assert.ok(r.blocks.every(b => b.closed));
  assert.deepStrictEqual(r.commentRuns, [{ start: 0, end: 1 }]);
}

// ---- sections inside a function end with the function ----
{
  const r = parse(['function f()', '  %% part one', '  a = 1;', '  %% part two', '  b = 2;', 'end', '%% after', 'c = 3;']);
  assert.deepStrictEqual(r.sections.map(s => `${s.title} ${s.start}-${s.end}`), ['part one 1-2', 'part two 3-4', 'after 6-7']);
}
console.log('parser: all assertions passed');

// ---------------- completion / signature helpers ----------------
{
  const params = (s: { label: string; params: [number, number][] } | undefined) => s?.params.map(([a, b]) => s.label.slice(a, b));
  let s = parseDeftypefn('@deftypefnx {} {@var{x} =} zeros (@var{m}, @var{n}, @dots{})');
  assert.strictEqual(s?.label, 'x = zeros (m, n, ...)');
  assert.deepStrictEqual(params(s), ['m', 'n', '...']);
  s = parseDeftypefn(' @deftypefn  {} {} plot (@var{y})');
  assert.deepStrictEqual([s?.label, params(s)], ['plot (y)', ['y']]);
  s = parseDeftypefn('@deftypefnx {} {@var{x} =} zeros ([@var{m}, @var{n}, @dots{}])');
  assert.deepStrictEqual(params(s), ['[m, n, ...]']);
  s = parseDeftypefn('@deftypefnx {} {[@var{tok}, @var{rem}] =} strtok (@var{str}, @var{delim})');
  assert.deepStrictEqual([s?.label, params(s)], ['[tok, rem] = strtok (str, delim)', ['str', 'delim']]);
  s = parseDeftypefn('@deftypefnx {} {@var{x} =} zeros (@dots{}, "like", @var{var})');
  assert.deepStrictEqual(params(s), ['...', '"like"', 'var']);
  s = parseDeftypefn('@deftypefn {} {} tic ()');
  assert.deepStrictEqual(params(s), []);
  assert.deepStrictEqual(params(signatureFromDeclaration('[a, b] = other(p, q)')), ['p', 'q']);
  assert.deepStrictEqual(params(signatureFromDeclaration('out = helper(v)')), ['v']);
  assert.strictEqual(cleanTexinfo('Return @code{0} for @var{x}@dots{} @@home @{a@}'), 'Return 0 for x... @home {a}');

  assert.deepStrictEqual(callContext('y = plot(x, '), { name: 'plot', param: 1 });
  assert.deepStrictEqual(callContext('y = zeros (3'), { name: 'zeros', param: 0 });
  assert.deepStrictEqual(callContext('f(a, g(b, c), '), { name: 'f', param: 2 });
  assert.deepStrictEqual(callContext('f(a, g(b, '), { name: 'g', param: 1 });
  assert.deepStrictEqual(callContext("disp('a, (b', x"), { name: 'disp', param: 1 });
  assert.deepStrictEqual(callContext("y = x'; sum(x', "), { name: 'sum', param: 1 });
  assert.strictEqual(callContext("disp('a, (b"), undefined);       // inside a string
  assert.strictEqual(callContext('plot(x) % (y, '), undefined);    // inside a comment
  assert.strictEqual(callContext('if (x > '), undefined);          // keyword, not a call
  assert.strictEqual(callContext('m = [1, 2, '), undefined);       // matrix, not a call
  assert.strictEqual(callContext('s.method(1, '), undefined);      // method call: no help lookup
  assert.deepStrictEqual(callContext('plot(x, ...\n  '), { name: 'plot', param: 1 });

  assert.deepStrictEqual(completionPrefix('x = pl'), { prefix: 'pl', segmentStart: 4 });
  assert.deepStrictEqual(completionPrefix('a = my_struct.na'), { prefix: 'my_struct.na', segmentStart: 14 });
  assert.deepStrictEqual(completionPrefix('s.'), { prefix: 's.', segmentStart: 2 });
  assert.deepStrictEqual(completionPrefix('x = '), { prefix: '', segmentStart: 4 });
  assert.strictEqual(completionPrefix("disp('pl"), undefined);
  assert.strictEqual(completionPrefix('x = 1 % pl'), undefined);
  assert.strictEqual(completionPrefix('x = 12'), undefined);
  assert.strictEqual(completionPrefix('x = 1.'), undefined);
  assert.deepStrictEqual(completionPrefix("y = x' + ab"), { prefix: 'ab', segmentStart: 9 });
}
console.log('signatures: all assertions passed');

// ---------------- grammar ----------------
async function grammarTests(): Promise<void> {
  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')).buffer;
  await oniguruma.loadWASM(wasm);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', 'octave.tmLanguage.json'), 'utf8'), 'octave.tmLanguage.json'),
  });
  const grammar = (await registry.loadGrammar('source.octave'))!;

  /** Scopes of the first occurrence of `needle` (after `from`) in each line of `src`. */
  const tokenize = (src: string[]) => {
    let stack = vsctm.INITIAL;
    return src.map(line => {
      const r = grammar.tokenizeLine(line, stack);
      stack = r.ruleStack;
      return { line, tokens: r.tokens };
    });
  };
  const scopeAt = (toks: ReturnType<typeof tokenize>, row: number, needle: string, nth = 0) => {
    const { line, tokens } = toks[row];
    let idx = -1;
    for (let k = 0; k <= nth; k++) { idx = line.indexOf(needle, idx + 1); }
    assert.ok(idx >= 0, `"${needle}" not in "${line}"`);
    const t = tokens.find(tk => tk.startIndex <= idx && idx < tk.endIndex)!;
    return t.scopes.join(' ');
  };
  const expect = (toks: ReturnType<typeof tokenize>, row: number, needle: string, scope: string, nth = 0) => {
    const s = scopeAt(toks, row, needle, nth);
    assert.ok(s.includes(scope), `line ${row} "${needle}": expected ${scope}, got ${s}`);
  };
  const expectNot = (toks: ReturnType<typeof tokenize>, row: number, needle: string, scope: string, nth = 0) => {
    const s = scopeAt(toks, row, needle, nth);
    assert.ok(!s.includes(scope), `line ${row} "${needle}": did not expect ${scope}, got ${s}`);
  };

  const t = tokenize([
    "%% Section title",                         // 0
    "x = a' + b.' * 'str' ;",                   // 1
    "s = 'it''s'; d = \"say \\\"hi\\\" %d\\n\";", // 2
    "y = x(end) + c{end-1};",                   // 3
    "if y > 0 % comment with 'quote'",          // 4
    "end",                                      // 5
    "function [a, b] = foo(p, ~)",              // 6
    "# hash comment",                           // 7
    "%{",                                       // 8
    "if inside block comment",                  // 9
    "%}",                                       // 10
    "z = 1e-3 + 2.5i + 0x1F; % # not code",     // 11
    "hold on",                                  // 12
    "s.end = [1 2 ...  continuation 'text",     // 13
    "  3];",                                    // 14
    "classdef (Sealed) Pt < handle",            // 15
    "q = [a' 'b'];",                            // 16
  ]);
  expect(t, 0, 'Section', 'markup.heading.section');
  expect(t, 0, '%%', 'comment.line.section');
  expect(t, 1, "'", 'keyword.operator.transpose');
  expect(t, 1, ".'", 'keyword.operator.transpose');
  expect(t, 1, 'str', 'string.quoted.single');
  expect(t, 2, 'it', 'string.quoted.single');
  expect(t, 2, "''", 'constant.character.escape');
  expect(t, 2, '\\"', 'constant.character.escape');
  expect(t, 2, '%d', 'constant.other.placeholder');
  expect(t, 3, 'end', 'variable.language.end');
  expect(t, 3, 'end', 'variable.language.end', 1);
  expect(t, 4, 'if', 'keyword.control');
  expect(t, 4, 'quote', 'comment.line.percentage');
  expect(t, 5, 'end', 'keyword.control');
  expect(t, 6, 'function', 'storage.type.function');
  expect(t, 6, 'foo', 'entity.name.function');
  expect(t, 6, 'a', 'variable.parameter.output');
  expect(t, 6, 'p', 'variable.parameter.input');
  expect(t, 7, 'hash', 'comment.line.number-sign');
  expect(t, 9, 'if', 'comment.block');
  expect(t, 10, '%}', 'comment.block');
  expect(t, 11, '1e-3', 'constant.numeric');
  expect(t, 11, '2.5i', 'constant.numeric');
  expect(t, 11, '0x1F', 'constant.numeric');
  expect(t, 11, '#', 'comment.line.percentage');
  expect(t, 12, 'hold', 'support.function');
  expect(t, 12, 'on', 'string.unquoted');
  expect(t, 13, 'end', 'variable.other.property');
  expectNot(t, 13, 'end', 'keyword.control');
  expect(t, 13, 'continuation', 'comment.line.continuation');
  expect(t, 14, '3', 'constant.numeric');
  expectNot(t, 14, '3', 'string');
  expect(t, 15, 'Pt', 'entity.name.type.class');
  expect(t, 15, 'handle', 'entity.other.inherited-class');
  expect(t, 16, "'", 'keyword.operator.transpose');
  expect(t, 16, 'b', 'string.quoted.single');
  console.log('grammar: all assertions passed');
}

grammarTests().catch(e => { console.error(e); process.exit(1); });
