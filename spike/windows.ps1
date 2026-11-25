# Lists visible top-level windows of a process and whether Windows considers them hung.
param([int]$TargetPid, [int]$All = 0)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> List(uint pid, bool all) {
    var r = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && (all || IsWindowVisible(h))) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        r.Add(sb.ToString() + "|visible=" + IsWindowVisible(h) + "|hung=" + IsHungAppWindow(h)); } return true; }, IntPtr.Zero);
    return r; }
}
"@
[W]::List([uint32]$TargetPid, $All -ne 0) | ForEach-Object { $_ }
