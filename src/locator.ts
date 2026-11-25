import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OctaveLaunch {
  /** Executable actually spawned. */
  exe: string;
  /** Extra arguments needed for this executable (e.g. --no-gui for octave-gui.exe). */
  args: string[];
  /** Human-readable note shown in the log. */
  note: string;
  /** Environment variables to set for the process (what Octave's own launcher would set). */
  env?: Record<string, string>;
}

/**
 * The environment Octave's Windows launcher (octave.bat / octave.vbs) sets up before starting the real binary.
 * Spawning octave-gui.exe directly skips it; without QT_PLUGIN_PATH Qt can crash (Octave bug #53419), and
 * packages that compile code need the MSYS tools on PATH.
 */
export function launcherEnv(exe: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!isWindows) { return {}; }
  const bin = path.dirname(exe);
  if (path.basename(bin).toLowerCase() !== 'bin') { return {}; }
  const octHome = path.dirname(bin);                 // ...\mingw64
  const root = path.dirname(octHome);                // ...\Octave-x.y.z
  const env: Record<string, string> = {};
  const pathParts = [bin];
  const sub = path.basename(octHome).toLowerCase();
  if (SUBDIRS.includes(sub) && sub) {
    if (isDir(path.join(root, 'usr', 'bin'))) { pathParts.push(path.join(root, 'usr', 'bin')); }
    env.MSYSTEM = sub.toUpperCase();
  }
  for (const qt of ['qt6', 'qt5']) {
    if (isDir(path.join(octHome, qt, 'bin'))) {
      pathParts.unshift(path.join(octHome, qt, 'bin'));
      env.QT_PLUGIN_PATH = path.join(octHome, qt, 'plugins');
      break;
    }
  }
  if (!env.QT_PLUGIN_PATH && isDir(path.join(octHome, 'plugins'))) { env.QT_PLUGIN_PATH = path.join(octHome, 'plugins'); }
  const pathKey = Object.keys(base).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...pathParts, base[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
  env.GNUTERM = base.GNUTERM ?? 'wxt';
  env.GS = base.GS ?? 'gs.exe';
  if (isDir(path.join(octHome, 'lib', 'pkgconfig'))) { env.PKG_CONFIG_PATH = path.join(octHome, 'lib', 'pkgconfig'); }
  if (!base.HOME && base.USERPROFILE) { env.HOME = base.USERPROFILE; }  // same ~/.octaverc as the Octave GUI
  return env;
}

const isWindows = process.platform === 'win32';
/** Where the binaries live inside an Octave installation folder (newest layouts first; "" = bin directly). */
const SUBDIRS = ['mingw64', 'ucrt64', 'clang64', 'clangarm64', 'mingw32', ''];
const WIN_NAMES = ['octave-gui.exe', 'octave-cli.exe', 'octave.exe', 'octave.bat'];
const UNIX_NAMES = ['octave-cli', 'octave'];

/**
 * Resolve which Octave binary to spawn.
 *
 * Spike findings (Octave 11.1, Windows 11):
 * - octave-gui.exe --no-gui: qt figures stay responsive while idle; CTRL_BREAK interrupts cleanly. Preferred.
 * - octave.exe is a launcher that starts octave-gui.exe as a child; a CTRL_BREAK kills both. Never spawn it directly.
 * - octave-cli.exe: works, but FLTK figure windows hang while Octave waits for input.
 *
 * The `octave.executable` setting may be a file, an installation or bin folder, or a command on PATH.
 * Without it: the standard install folders, the Windows uninstall registry (custom install locations),
 * Scoop, and finally PATH.
 */
export function resolveOctave(configured: string | undefined): OctaveLaunch {
  if (configured && configured.trim()) {
    const raw = expand(configured.trim().replace(/^"(.*)"$/, '$1'));
    const exe = fromSetting(raw);
    if (!exe) {
      throw new Error(`octave.executable is set to "${configured}", but no Octave executable was found there.`);
    }
    return withEnv(forExecutable(exe, 'from octave.executable setting'));
  }
  const found = autoDetect();
  if (!found) {
    throw new Error(isWindows
      ? 'Could not find GNU Octave. Install it (https://octave.org/download) or set "octave.executable" to octave-gui.exe or the Octave folder.'
      : 'Could not find GNU Octave on PATH. Install it or set "octave.executable".');
  }
  return withEnv(forExecutable(found.exe, `auto-detected (${found.how})`));
}

function withEnv(l: OctaveLaunch): OctaveLaunch {
  return { ...l, env: launcherEnv(l.exe) };
}

/** Expand ~ and %VAR% / ${env:VAR} in a configured path. */
function expand(p: string): string {
  return p
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m)
    .replace(/\$\{env:([^}]+)\}/g, (m, v) => process.env[v] ?? m);
}

function fromSetting(p: string): string | undefined {
  // Start-menu shortcut targets (octave.vbs, octave-launch.exe): use the installation they belong to.
  if (isFile(p) && /^(octave(-firsttime)?\.vbs|octave-launch.*\.exe|.*\.lnk)$/i.test(path.basename(p))) {
    return inInstallDir(path.dirname(p));
  }
  if (isFile(p)) { return p; }
  if (isDir(p)) { return inInstallDir(p); }
  // A bare command name ("octave", "octave-cli"): look on PATH.
  if (!/[\\/]/.test(p)) { return onPath([p, ...(isWindows && !/\.\w+$/.test(p) ? [`${p}.exe`, `${p}.bat`] : [])]); }
  return undefined;
}

function forExecutable(exe: string, how: string): OctaveLaunch {
  const dir = path.dirname(exe);
  const base = path.basename(exe).toLowerCase();
  if (isWindows && /^octave(-\d[\d.]*)?\.(exe|bat)$/.test(base)) {
    // The launcher may sit one level up (installation root) or next to the real binaries.
    for (const d of [dir, ...SUBDIRS.filter(s => s).map(s => path.join(dir, s, 'bin'))]) {
      const gui = path.join(d, 'octave-gui.exe');
      if (isFile(gui)) { return { exe: gui, args: ['--no-gui'], note: `${how}; using octave-gui.exe instead of the ${base} launcher` }; }
      const cli = path.join(d, 'octave-cli.exe');
      if (isFile(cli)) { return { exe: cli, args: [], note: `${how}; using octave-cli.exe instead of the ${base} launcher` }; }
    }
  }
  if (base.startsWith('octave-gui')) {
    return { exe, args: ['--no-gui'], note: how };
  }
  if (!isWindows && base === 'octave') {
    return { exe, args: ['--no-gui'], note: how };
  }
  return { exe, args: [], note: how };
}

/** The best binary inside an installation folder, its bin folder, or an Octave-x.y.z folder. */
function inInstallDir(dir: string): string | undefined {
  const names = isWindows ? WIN_NAMES : UNIX_NAMES;
  for (const sub of ['', ...SUBDIRS.map(s => path.join(s, 'bin'))]) {
    for (const n of names) {
      const p = path.join(dir, sub, n);
      if (isFile(p)) { return p; }
    }
  }
  return undefined;
}

function autoDetect(): { exe: string; how: string } | undefined {
  if (!isWindows) {
    const p = onPath(UNIX_NAMES);
    return p ? { exe: p, how: 'PATH' } : undefined;
  }
  const roots = new Set<string>();
  for (const base of [process.env['ProgramFiles'] ?? 'C:\\Program Files', process.env['ProgramW6432'], process.env['ProgramFiles(x86)'],
                      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')]) {
    if (base) { roots.add(path.join(base, 'GNU Octave')); }
  }
  // Installation folders: <root>\Octave-x.y.z, newest version first.
  const installs: { version: number[]; dir: string; how: string }[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const m = /^Octave-(\d+(?:\.\d+)*)/i.exec(entry);
      if (m) { installs.push({ version: m[1].split('.').map(Number), dir: path.join(root, entry), how: root }); }
    }
  }
  const pick = () => {
    installs.sort((a, b) => compareVersions(b.version, a.version));
    for (const inst of installs) {
      const exe = inInstallDir(inst.dir);
      if (exe) { return { exe, how: inst.how }; }
    }
    return undefined;
  };
  const standard = pick();
  if (standard) { return standard; }

  // Not in a standard folder: custom install location (registry, ~1 s), Scoop, then PATH.
  installs.length = 0;
  for (const loc of registryInstallLocations()) {
    const m = /(\d+(?:\.\d+)+)/.exec(path.basename(loc));
    installs.push({ version: m ? m[1].split('.').map(Number) : [0], dir: loc, how: 'registry' });
  }
  const scoop = path.join(process.env['SCOOP'] ?? path.join(os.homedir(), 'scoop'), 'apps', 'octave', 'current');
  installs.push({ version: [0], dir: scoop, how: 'Scoop' });
  const custom = pick();
  if (custom) { return custom; }
  const p = onPath(WIN_NAMES);
  return p ? { exe: p, how: 'PATH' } : undefined;
}

/** InstallLocation values of "GNU Octave" entries in the Windows uninstall registry (custom install folders). */
function registryInstallLocations(): string[] {
  const out: string[] = [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const reg = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
  for (const key of keys) {
    try {
      const r = spawnSync(reg, ['query', key, '/s', '/f', 'Octave', '/d'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (r.status !== 0 || !r.stdout) { continue; }
      // Each match is a key; read its InstallLocation / UninstallString.
      for (const sub of r.stdout.split(/\r?\n/).filter(l => /^HKEY_/.test(l))) {
        const v = spawnSync(reg, ['query', sub], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout ?? '';
        if (!/DisplayName\s+REG_SZ\s+.*Octave/i.test(v)) { continue; }
        const loc = /InstallLocation\s+REG_\w+\s+(.+)/.exec(v)?.[1]?.trim()
          ?? path.dirname(/UninstallString\s+REG_\w+\s+"?([^"\r\n]+)"?/.exec(v)?.[1]?.trim() ?? '');
        if (loc && loc !== '.' && isDir(loc)) { out.push(loc.replace(/[\\/]+$/, '')); }
      }
    } catch { /* reg.exe unavailable */ }
  }
  return [...new Set(out)];
}

function onPath(names: string[]): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) { continue; }
    for (const name of names) {
      const p = path.join(dir.replace(/^"(.*)"$/, '$1'), name);
      if (isFile(p)) { return p; }
    }
  }
  return undefined;
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) { return d; }
  }
  return 0;
}
