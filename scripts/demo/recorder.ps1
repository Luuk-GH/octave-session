# Captures the demo VS Code window (title contains -Title) to JPEG frames while <Ctl> holds a scene name.
# Writes <Out>/<scene>/NNNNN.jpg plus <scene>/times.txt (ms since scene start). Stops when <Ctl> contains "quit".
# -Screen: keep the window on top and copy it from the screen (about 15 fps, for GIFs) instead of PrintWindow
# (about 3 fps, but works while the window is covered).
param([string]$Title = 'octave-demo', [string]$Ctl, [string]$Out, [int]$W = 1920, [int]$H = 1080, [int]$IntervalMs = 100,
      [switch]$Screen)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Rec {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@
[Rec]::SetProcessDPIAware() | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 93L
$hwnd = [IntPtr]::Zero; $placed = $false
$scene = ''; $n = 0; $sw = $null; $times = $null
while ($true) {
  $want = ''
  try { $want = (Get-Content -Raw $Ctl -ErrorAction Stop).Trim() } catch {}
  if ($want -eq 'quit') { break }
  if ($hwnd -eq [IntPtr]::Zero -or -not $placed) {
    $p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
    if ($p) {
      $hwnd = $p.MainWindowHandle
      [Rec]::ShowWindow($hwnd, 9) | Out-Null   # restore (not maximized)
      $after = if ($Screen) { [IntPtr](-1) } else { [IntPtr]::Zero }   # HWND_TOPMOST while recording from the screen
      [Rec]::SetWindowPos($hwnd, $after, 0, 0, $W, $H, 0x0040) | Out-Null
      $placed = $true
    }
  }
  if ($want -ne $scene) {
    if ($times) { $times.Close() }
    $scene = $want; $n = 0; $times = $null
    if ($scene) {
      $dir = Join-Path $Out $scene
      New-Item -ItemType Directory -Force $dir | Out-Null
      $times = [System.IO.StreamWriter]::new((Join-Path $dir 'times.txt'))
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
    }
  }
  if ($scene -and $hwnd -ne [IntPtr]::Zero) {
    $t0 = $sw.ElapsedMilliseconds
    $r = New-Object Rec+RECT
    [Rec]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    if ($Screen) {
      $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    } else {
      $hdc = $g.GetHdc()
      [Rec]::PrintWindow($hwnd, $hdc, 2) | Out-Null
      $g.ReleaseHdc($hdc)
    }
    $g.Dispose()
    $n++
    $bmp.Save((Join-Path $Out ("$scene\{0:D5}.jpg" -f $n)), $codec, $ep); $bmp.Dispose()
    $times.WriteLine($t0); $times.Flush()
    $left = $IntervalMs - ($sw.ElapsedMilliseconds - $t0)
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
  } else { Start-Sleep -Milliseconds 100 }
}
if ($times) { $times.Close() }
