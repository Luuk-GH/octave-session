// Records the demo: installs the .vsix into a fresh VS Code profile, drives it (driver/run.js, or the driver named
// in DEMO_SCRIPT, e.g. commandWindow.js for the Command Window screenshots) and records the
// window (recorder.ps1). Frames land in <out>/frames/<scene>/. Usage: node scripts/demo/run-demo.mjs <out> <vsix>
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2]);
const vsix = path.resolve(process.argv[3]);
const ws = path.join(out, 'octave-demo');
const ud = path.join(out, 'user-data');
const exts = path.join(out, 'extensions');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.cpSync(path.join(here, 'workspace'), ws, { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'window.restoreWindows': 'none',
  'editor.fontSize': 15, 'terminal.integrated.fontSize': 14, 'editor.minimap.enabled': false,
  'workbench.tips.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.ignoreRecommendations': true, 'chat.disableAIFeatures': true, 'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'security.workspace.trust.enabled': false,
  'window.title': 'octave-demo', 'breadcrumbs.enabled': false,
  'workbench.layoutControl.enabled': false, 'window.commandCenter': false,
}, null, 2));

const codeDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
const inst = spawnSync(`"${path.join(codeDir, 'bin', 'code.cmd')}"`, ['--extensions-dir', `"${exts}"`, '--user-data-dir', `"${ud}"`,
  '--install-extension', `"${vsix}"`, '--force'], { encoding: 'utf8', shell: true });
console.log(inst.stdout, inst.stderr);

const ctl = path.join(out, 'ctl.txt');
const logf = path.join(out, 'driver.log');
fs.writeFileSync(ctl, '');
fs.writeFileSync(logf, '');
// DEMO_SCREEN=1: fast capture from the screen (window kept on top); DEMO_W / DEMO_H: window size.
const recArgs = ['-Title', 'octave-demo', '-Ctl', ctl, '-Out', path.join(out, 'frames'),
  '-W', process.env.DEMO_W ?? '1920', '-H', process.env.DEMO_H ?? '1080'];
if (process.env.DEMO_SCREEN) { recArgs.push('-Screen', '-IntervalMs', '60'); }
const recorder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'recorder.ps1'),
  ...recArgs], { stdio: 'inherit' });

const script = process.env.DEMO_SCRIPT ?? 'run.js';
// OCTAVE_IT_RESULT enables the Command Window's test hooks, which the screenshot driver uses.
const env = { ...process.env, DEMO_CTL: ctl, DEMO_LOG: logf, OCTAVE_IT_RESULT: path.join(out, 'unused-result.txt') };
delete env.ELECTRON_RUN_AS_NODE;
const code = spawn(path.join(codeDir, 'Code.exe'), [
  `--extensionDevelopmentPath=${path.join(here, 'driver')}`,
  `--extensionTestsPath=${path.join(here, 'driver', script)}`,
  `--user-data-dir=${ud}`, `--extensions-dir=${exts}`,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', ws,
], { stdio: 'ignore', env });
code.on('exit', c => {
  console.log('VS Code exited', c);
  fs.writeFileSync(ctl, 'quit');
  recorder.on('exit', () => { console.log(fs.readFileSync(logf, 'utf8')); });
});
