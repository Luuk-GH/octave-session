// Launches a spike script in a process without a visible console, mimicking the VS Code extension host.
//   default:          detached (DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP, no console at all)
//   SPIKE_NOGROUP=1:  Start-Process -WindowStyle Hidden (own hidden console, normal process group)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const script = path.join(__dirname, process.argv[2] || 'spike.js');
const logFile = path.join(__dirname, 'spike-results.log');

if (process.env.SPIKE_NOGROUP) {
  const errFile = logFile + '.err';
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Start-Process -FilePath '${process.execPath}' -ArgumentList '"${script}"' -WindowStyle Hidden -Wait ` +
    `-RedirectStandardOutput '${logFile}' -RedirectStandardError '${errFile}'`], { stdio: 'inherit', env: process.env });
  process.stdout.write(fs.readFileSync(logFile, 'utf8') + fs.readFileSync(errFile, 'utf8'));
} else {
  const fd = fs.openSync(logFile, 'w');
  const c = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  c.on('exit', code => { fs.closeSync(fd); process.stdout.write(fs.readFileSync(logFile, 'utf8')); process.exit(code ?? 0); });
}
