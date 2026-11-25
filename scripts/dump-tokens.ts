// Print the grammar's tokens and scopes for lines of an .m file that contain any of the given texts.
// npm run tokens -- test/syntax_demo.m "sprintf" "numel"
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
(async () => {
  const root = process.cwd();
  await oniguruma.loadWASM(fs.readFileSync(path.join(root, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
  const reg = new vsctm.Registry({ onigLib: Promise.resolve({ createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
    loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes/octave.tmLanguage.json'), 'utf8'), 'x.json') });
  const g = (await reg.loadGrammar('source.octave'))!;
  let st = vsctm.INITIAL;
  for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
    const r = g.tokenizeLine(line, st); st = r.ruleStack;
    if (!process.argv.slice(3).some(n => line.includes(n))) continue;
    console.log(line);
    for (const t of r.tokens) console.log('   ', JSON.stringify(line.slice(t.startIndex, t.endIndex)), t.scopes.slice(1).join(' '));
  }
})();
