// Runs a Node script detached from any console (DETACHED_PROCESS), like the VS Code extension host,
// and relays its output. Usage: node scripts/run-detached.mjs <script.js>
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const script = path.resolve(process.argv[2]);
const logFile = path.join(os.tmpdir(), `run-detached-${process.pid}.log`);
const fd = fs.openSync(logFile, 'w');
const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
child.on('exit', code => {
  fs.closeSync(fd);
  process.stdout.write(fs.readFileSync(logFile, 'utf8'));
  fs.rmSync(logFile, { force: true });
  process.exit(code ?? 1);
});
