# Changelog

## 0.2.0

- **First Marketplace release**, published as `LuukP.octave-session`. If you installed an earlier .vsix
  (`local.octave-session`), uninstall it first: both register the same commands.
- README with highlight GIFs for each feature.
- New icon: the Octave ring drawn as a vinyl record.
- With the Command Window as the default view, starting the debugger no longer switches the panel to VS Code's
  Debug Console (Octave's Command Window is where you type while paused). Set `internalConsoleOptions` in a
  launch configuration to change this.
- **Command Window** in the bottom panel (*Octave* tab next to Terminal), modelled on MATLAB's: HTML output with
  mouse selection, errors in red, clickable file/line links (paths and "called from" frames) and collapsible long
  outputs; a CodeMirror input line with Octave highlighting, Enter / Shift+Enter, prefix-filtered history,
  a completion pop-up and help tooltip from the live session (only asked when Octave is idle), a usage hint while
  typing a call, and a Stop button. It shares the one Octave process and workspace with Run, the debugger, the
  terminal and the MCP server; output is replayed when the view is opened later.
- **`octave.commandWindow.view`** (`webview` by default, or `terminal`): which Command Window opens. The terminal view
  stays available (*Octave: Show Command Window as Terminal*); closing it only ends the session when it is the
  chosen view.
- **`input`, `yes_or_no` and `pause`** no longer leave the Command Window looking busy: both views switch to
  answering them, and Stop works while Octave waits. `pause` without an argument now continues on Enter (it used to
  wait for a key in Octave's hidden console, so only Ctrl+C ended it). **`clc`** clears the Command Window.
- **Command queue**: one line in flight at a time (as before), now in its own tested class. Completion and help
  queries are refused at once while a command runs instead of waiting behind it.

## 0.1.3

- **`edit` and `open` open files in VS Code:** `edit name` / `open name` open a script or function (yours or
  Octave's) in the editor, `edit newname` creates `newname.m` in the current folder, `edit` opens an untitled
  Octave file. `open` of other files (`.mat`, `.ofig`, ...) works as before.
- **Agent skills** in `agent-toolkit/` (not part of the .vsix): a Claude Code plugin `octave-core` with four skills
  that teach agents to use the MCP server: run code, debugging, testing (Octave's `%!` test blocks) and code review.

## 0.1.2

- **Workspace view** (Octave icon in the activity bar): variables of the live session, or of the current frame while
  debugging, with value, size and class. Structs, cells and matrices expand. Show in Command Window, Copy Value,
  Copy Expression, Delete (also the Delete key) and Clear Workspace. It refreshes after each command and debugger
  step while visible, and appears once Octave is used in a window.

## 0.1.1

- **MCP server for AI agents** (off by default, `octave.mcp.enabled`): Claude Code, Copilot, Cursor and other MCP
  clients can run code, inspect the workspace, read help, interrupt and drive the debugger in the same live Octave
  session you see. Streamable HTTP on `127.0.0.1` with a bearer token. *Octave: Set Up MCP Server* copies the
  connection details; *Octave: Reset MCP Token* replaces the token.
- The extension now activates at VS Code startup (it starts no Octave process until needed). The status bar item
  only appears once an Octave file is open or a session starts.
- **Robustness fixes:**
  - Closing VS Code while a program runs no longer leaves Octave running in the background.
  - Incomplete input in the Debug Console (`if x`) is a parse error instead of jamming the session.
  - Breakpoint changes dropped by Ctrl+C are sent again; none are sent into a half-typed block.
  - Debugger requests while a program runs fail with "Octave is running" instead of hanging.
  - Octave that never shows a prompt is stopped after 120 s; a failed setup no longer leaves a half-working session.
  - Output and exit events of a replaced session no longer reach the new one.
  - Signature help is refreshed after a `.m` file is saved.

## 0.1.0

First release.

- **Persistent session:** one Octave session behind the *Octave* Command Window. It runs files, selections and
  `%%` sections, and Ctrl+C interrupts it.
- **Breakpoint debugger** on the same session: breakpoints apply in any run, the debugger attaches automatically,
  and you get stepping, call stack, variables, watch, hover and the debug console.
- **Completion and signature help** from the live session, with a cached function list while Octave is busy.
  Tab completion and usage hints in the Command Window.
- **Language support:** syntax highlighting, outline, folding, indentation and section separators.
- **Robust setup for other PCs:**
  - Octave is found in standard folders, custom install locations (registry), Scoop and `PATH`.
  - `octave.executable` accepts files, folders and commands.
  - Octave starts with the same environment its own launcher sets.
  - Works with Octave 6+.
  - Clear messages when Octave is missing or fails to start.
  - Workspace Trust support.
  - A hint when the MATLAB extension claims `.m` files.
  - Temp folders from crashed sessions are cleaned up.
