# Windows spike results — Octave 11.1.0, Windows 11 (2026-11-15)

Tests ran from a Node process with no console (`run-spike.js` launches detached), like the VS Code
extension host. The scripts are kept here so the results can be reproduced: `node run-spike.js spike2.js` etc.

## Interrupt (Ctrl+C)

| Method | Result |
|---|---|
| `CTRL_C_EVENT` via `GenerateConsoleCtrlEvent` (helper attaches to Octave's hidden console) | **Ignored.** Octave keeps running and stops responding to later input. Same with or without a new process group. |
| `CTRL_BREAK_EVENT`, same route | **Works.** A busy `while` loop or `pause(30)` aborts in ~0.2–0.7 s, Octave returns to the prompt, the workspace is kept. |
| `CTRL_BREAK_EVENT` when the spawned binary is `octave.exe` | **Kills the session.** `octave.exe` is a launcher with `octave-gui.exe` as child; both die. |

Caveat: one break during a tight `plot(...); drawnow` loop did not stop it within 6 s. Pressing Ctrl+C again sends another break.

The implementation keeps one Windows PowerShell helper running, with the C# code loaded in memory via `Add-Type`.
Each interrupt is one line on its stdin (~150 ms). An earlier version compiled the helper to an `.exe`, but
**Smart App Control** (on in enforce mode on this machine) blocks unsigned executables, and the spawn failed
with "spawn UNKNOWN". Don't write custom binaries to disk. The helper refuses to send if Octave's console is shared with the extension host, because a break there would kill the host.

## Plot windows

| Binary / toolkit | Figure visible | Responsive while idle at the prompt |
|---|---|---|
| `octave-cli.exe` / fltk | First figure hidden (see below) | **No.** Windows reports it hung after ~5 s, because Octave blocks reading stdin and nothing pumps messages. |
| `octave.exe --no-gui` / qt | Yes | Yes, but see the interrupt row above |
| **`octave-gui.exe --no-gui` / qt** | Yes, with the startup fix below | **Yes** |

Hidden first figure: `windowsHide: true` (needed so Octave's console window doesn't flash up) puts `SW_HIDE` in STARTUPINFO,
and Windows applies that to the process's first shown window. Fix: at startup the session creates and closes one throwaway
off-screen figure. Verified: later figures are visible and responsive.

## Other checks

- Output streams live over pipes (with `--interactive`, `more off`).
- Prompt sentinels work: `PS1`/`PS2` set to control-character markers; one marker per input line; errors (stderr) arrive before the marker if we wait ~30 ms.
- Non-ASCII paths (`octave smoke tëst ü`): `run`, `cd`, `exist` work; UTF-8 output decodes correctly.

## Decision

Spawn **`octave-gui.exe --no-gui --interactive --no-line-editing`** on pipes behind a VS Code Pseudoterminal.
`octave-cli.exe` still works via the `octave.executable` setting, but its FLTK windows freeze. If `octave.exe` is configured, the extension uses `octave-gui.exe` from the same folder instead.

# Debugger probes (phase 2) — `spike6.js` … `spike10.ts`

- **Debug prompt:** in the debugger Octave ignores `PS1` and prints a fixed `debug> `. It is treated as a prompt when it ends the output and either Octave was already in the debugger or stderr just said `stopped in …`. `keyboard` at the top level prints no stop message, so a `debug> ` followed by 500 ms of silence also counts. `PS2` still works inside the debugger.
- **Stop message** (stderr): `stopped in NAME at line N [FILE]` then `N: code`. This applies to breakpoints, steps and `dbstop if error`.
- **`dbstop` needs a function/script name**, not a path (paths fail with "unable to find function"). For a file that is not on the path or in the current folder, the extension runs `addpath(dir)`, then `dbstop(name, "line")`, then `rmpath(dir)`, and the breakpoint is kept. The line must be passed as a string. `dbstop` returns the line actually used (a comment line moves to the next statement).
- **`run(file)` / `source(file)` re-parse the file and ignore its breakpoints.** Run File therefore calls the script *by name* from its folder (`__vsc_run__`: `cd`, then `evalin("base", name)`). The folder is restored with `onCleanup`, because `dbquit` skips `unwind_protect` cleanup.
- **Stale parses:** Octave checks file timestamps at one-second granularity, so a file edited within the same second keeps running its old version. The extension marks saved files and runs `clear -f name` before the next run. This drops breakpoints, so they are re-applied.
- `clear all` in a script also drops breakpoints (MATLAB does the same). Run File re-applies all breakpoints first.
- **Frames:** `dbup(n)` / `dbdown(n)` take effect only after their own input line, so they are sent separately before a query. A helper function called at the debug prompt sees the selected frame via `evalin("caller", …)`. `dbstack` called inside a helper always reports idx 0, so it can't be used to read the selection.
- **Pause is not possible:** `debug_on_interrupt(true)` only applies to SIGINT. CTRL_BREAK (the only working interrupt, see above) aborts to the top level, even when the run was resumed from the debugger.
- With `dbstop if error`, errors inside `try` blocks don't stop. The helpers catch their own errors, so a bad watch expression can't nest the debugger.
