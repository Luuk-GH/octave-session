// "Fresh PC" check: install the packaged .vsix into a brand-new VS Code profile and extensions folder
// (no settings, no cached state, extension loaded from the .vsix, not from this folder), then run the
// integration tests against it.   npm run package && node scripts/run-vsix-test.mjs
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) { console.error(`missing ${vsix}: run npm run package first`); process.exit(2); }

const base = path.join(os.tmpdir(), 'octave-vsix-test');
fs.rmSync(base, { recursive: true, force: true });
const userData = path.join(base, 'user-data');
const extDir = path.join(base, 'extensions');
const stub = path.join(base, 'stub');   // empty development extension: only needed to host the test runner
fs.mkdirSync(stub, { recursive: true });
fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
  name: 'test-host-stub', publisher: 'local', version: '0.0.0', engines: { vscode: '^1.95.0' },
}));
const resultFile = path.join(base, 'result.txt');

const codeDir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code');
const codeExe = process.env.VSCODE_EXE ?? path.join(codeDir, 'Code.exe');
const codeCli = path.join(codeDir, 'bin', 'code.cmd');
const env = { ...process.env, OCTAVE_IT_RESULT: resultFile };
delete env.ELECTRON_RUN_AS_NODE;

// code.cmd is a batch file, so it needs a shell; quote everything (paths contain spaces).
const q = s => `"${s}"`;
const inst = spawnSync(q(codeCli), [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, '--install-extension', vsix].map(q),
  { encoding: 'utf8', shell: true, env });
console.log(inst.stdout.trim());
if (inst.status !== 0) { console.error(inst.stderr); process.exit(2); }

const child = spawn(codeExe, [
  `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`,
  `--extensionDevelopmentPath=${stub}`,
  `--extensionTestsPath=${path.join(root, 'dist', 'integration.test.js')}`,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  path.join(root, 'test'),
], { stdio: 'inherit', env });
child.on('exit', code => {
  process.stdout.write('\n' + (fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '(no result file written)\n'));
  process.exit(code ?? 1);
});
