// Opens a separate VS Code (own user-data-dir) with the extension and the MCP server on, in a scratch copy of
// agent-toolkit/evals/fixtures, and writes the MCP config for Claude Code to <tmp>/octave-agent-host/mcp.json.
// Stop it by creating <tmp>/octave-agent-host/stop (or close the window).
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'octave-agent-host');
const info = path.join(base, 'info.json');
const stop = path.join(base, 'stop');
const work = path.join(base, 'work');
fs.mkdirSync(base, { recursive: true });
for (const f of [info, stop, path.join(base, 'mcp.json')]) { fs.rmSync(f, { force: true }); }
fs.rmSync(work, { recursive: true, force: true });
fs.cpSync(path.join(root, 'agent-toolkit', 'evals', 'fixtures'), work, { recursive: true });

const codeExe = process.env.VSCODE_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const args = [
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'dist', 'agent-host.test.js')}`,
  `--user-data-dir=${path.join(base, 'user-data')}`,
  `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  work,
];
// OCTAVE_IT_RESULT makes the extension API expose the MCP token (test builds only).
const env = { ...process.env, OCTAVE_AGENT_INFO: info, OCTAVE_AGENT_STOP: stop, OCTAVE_IT_RESULT: path.join(base, 'unused.txt') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(codeExe, args, { stdio: 'ignore', env, detached: true });
child.unref();

const end = Date.now() + 120000;
while (!fs.existsSync(info) && Date.now() < end) { await new Promise(r => setTimeout(r, 500)); }
if (!fs.existsSync(info)) { console.error('MCP server did not come up within 120 s'); process.exit(1); }
const { port, token } = JSON.parse(fs.readFileSync(info, 'utf8'));
const mcp = { mcpServers: { octave: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
fs.writeFileSync(path.join(base, 'mcp.json'), JSON.stringify(mcp, null, 2));
console.log(`MCP server on port ${port}\nconfig: ${path.join(base, 'mcp.json')}\nworkspace: ${work}\nstop: create ${stop}`);
