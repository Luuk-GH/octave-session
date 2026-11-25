import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Interrupting Octave on Windows.
 *
 * Spike findings (Octave 11.1): POSIX-style signals don't exist, and CTRL_C_EVENT sent via
 * GenerateConsoleCtrlEvent is ignored by Octave when it runs on pipes. CTRL_BREAK_EVENT works:
 * Octave aborts the running command, returns to the prompt and keeps its workspace.
 *
 * The event must be raised from a process attached to Octave's (hidden) console. A long-lived
 * Windows PowerShell helper (signed by Microsoft, present on every Windows 10/11) loads a small
 * C# class in memory once; each interrupt is one line on its stdin. No executable is written to
 * disk, so Smart App Control / WDAC policies that block unsigned binaries don't get in the way
 * (an earlier version compiled a helper .exe and was blocked with "spawn UNKNOWN").
 *
 * The helper refuses if Octave's console is shared with the extension host (guard pid):
 * a break there would kill VS Code's extension host.
 */
const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class OctaveBreak {
  public delegate bool HandlerRoutine(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(HandlerRoutine h, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetConsoleProcessList(uint[] list, uint count);
  static readonly HandlerRoutine Ignore = t => true;  // keep the helper alive when the break reaches it
  public static string Send(uint target, uint guard) {
    SetConsoleCtrlHandler(Ignore, true);
    FreeConsole();
    if (!AttachConsole(target)) { return "2 AttachConsole failed: " + Marshal.GetLastWin32Error(); }
    try {
      SetConsoleCtrlHandler(Ignore, true);
      uint[] list = new uint[128];
      uint n = GetConsoleProcessList(list, 128);
      for (int i = 0; i < n && i < list.Length; i++) {
        if (guard != 0 && list[i] == guard) { return "4 console is shared with the extension host"; }
      }
      if (!GenerateConsoleCtrlEvent(1 /* CTRL_BREAK_EVENT */, 0)) { return "3 GenerateConsoleCtrlEvent failed: " + Marshal.GetLastWin32Error(); }
      System.Threading.Thread.Sleep(100);  // let the event be dispatched before detaching
      return "0 ok";
    } finally { FreeConsole(); }
  }
}`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In; $out = [Console]::Out
Add-Type -TypeDefinition @'
${CSHARP}
'@
$out.WriteLine('HELPER_READY'); $out.Flush()
while ($true) {
  $line = $in.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -lt 2) { continue }
  try { $r = [OctaveBreak]::Send([uint32]$parts[0], [uint32]$parts[1]) } catch { $r = '5 ' + $_.Exception.Message }
  $out.WriteLine('RESULT ' + $r); $out.Flush()
}
`;

export class Interrupter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private waiters: ((line: string) => void)[] = [];
  private buf = '';

  constructor(private readonly log: (msg: string) => void) {}

  /** Start the helper if needed (~1–2 s). Call early so the first interrupt is fast. */
  prepare(): Promise<void> {
    if (process.platform !== 'win32') { return Promise.resolve(); }
    return this.ensure().then(() => undefined);
  }

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null) { return Promise.resolve(this.proc); }
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      const ps = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const proc = spawn(fs.existsSync(ps) ? ps : 'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: 'pipe' });
      proc.stdin.on('error', () => { /* helper died; the next interrupt reports it */ });
      let ready = false;
      let stderr = '';
      const timer = setTimeout(() => { if (!ready) { proc.kill(); reject(new Error('interrupt helper did not start within 30 s')); } }, 30000);
      proc.stderr.on('data', d => { stderr += d; });
      proc.stdout.on('data', (d: Buffer) => {
        this.buf += d.toString();
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!ready && line === 'HELPER_READY') {
            ready = true; clearTimeout(timer); this.proc = proc;
            this.log(`interrupt helper started (pid ${proc.pid})`);
            resolve(proc);
          } else if (line.startsWith('RESULT ')) {
            this.waiters.shift()?.(line.slice(7));
          }
        }
      });
      proc.on('error', err => { clearTimeout(timer); reject(new Error(`interrupt helper failed to start: ${err.message}`)); });
      proc.on('exit', code => {
        clearTimeout(timer);
        if (this.proc === proc) { this.proc = undefined; }
        for (const w of this.waiters.splice(0)) { w(`5 helper exited (${code})`); }
        if (!ready) { reject(new Error(`interrupt helper exited (code ${code}): ${stderr.trim().slice(0, 500)}`)); }
        else { this.log(`interrupt helper exited (code ${code})`); }
      });
    });
  }

  /** Send CTRL_BREAK to the console of `pid`. Resolves when the event has been raised. */
  async interrupt(pid: number): Promise<void> {
    if (process.platform !== 'win32') {
      process.kill(pid, 'SIGINT');  // Octave handles SIGINT natively outside Windows
      return;
    }
    const proc = await this.ensure();
    const result = await new Promise<string>((resolve) => {
      const waiter = (line: string) => { clearTimeout(timer); resolve(line); };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) { this.waiters.splice(i, 1); }
        resolve('5 helper did not answer within 10 s');
      }, 10000);
      this.waiters.push(waiter);
      proc.stdin.write(`${pid} ${process.pid}\n`);
    });
    const code = result.split(' ')[0];
    if (code === '0') { return; }
    this.log(`interrupt failed: ${result}`);
    if (code === '4') {
      throw new Error('Octave shares a console with the VS Code extension host, so it cannot be interrupted safely.');
    }
    throw new Error(`interrupt failed: ${result.slice(2)}. If PowerShell is blocked on this PC (e.g. by policy), Ctrl+C can't stop Octave; use Octave: Restart Session instead.`);
  }

  dispose(): void {
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* ignore */ } this.proc.kill(); }
    this.proc = undefined;
  }
}
