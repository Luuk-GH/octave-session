# Sends CTRL_C_EVENT to the console owned by TargetPid.
# Refuses if that console is shared with GuardPid (e.g. the VS Code extension host).
param([int]$TargetPid, [int]$GuardPid = 0, [int]$CtrlEvent = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K32 {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] l, uint n);
}
"@
[K32]::FreeConsole() | Out-Null
if (-not [K32]::AttachConsole([uint32]$TargetPid)) { [Console]::Error.WriteLine("attach failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 2 }
$list = New-Object 'uint32[]' 64
$n = [K32]::GetConsoleProcessList($list, 64)
if ($GuardPid -ne 0 -and ($list[0..([int]$n-1)] -contains [uint32]$GuardPid)) { [K32]::FreeConsole() | Out-Null; [Console]::Error.WriteLine("console shared with guard pid"); exit 4 }
[K32]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
$ok = [K32]::GenerateConsoleCtrlEvent([uint32]$CtrlEvent, 0)
Start-Sleep -Milliseconds 50
[K32]::FreeConsole() | Out-Null
if (-not $ok) { exit 3 }
exit 0
