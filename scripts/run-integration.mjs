// Launches a separate VS Code instance (own user-data-dir) as Extension Development Host and runs
// dist/integration.test.js inside it. Works while your normal VS Code is open.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'octave-it-vscode');
const resultFile = path.join(base, 'result.txt');
fs.mkdirSync(base, { recursive: true });
fs.rmSync(resultFile, { force: true });

const codeExe = process.env.VSCODE_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const args = [
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'dist', 'integration.test.js')}`,
  `--user-data-dir=${path.join(base, 'user-data')}`,
  `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  path.join(root, 'test'),
];
// ELECTRON_RUN_AS_NODE would make Code.exe behave like node; make sure it is not inherited.
const env = { ...process.env, OCTAVE_IT_RESULT: resultFile, OCTAVE_IT_SHOT: path.join(base, 'terminal.png') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(codeExe, args, { stdio: 'inherit', env });
child.on('exit', code => {
  const out = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '(no result file written)\n';
  process.stdout.write('\n' + out);
  process.exit(code ?? 1);
});
