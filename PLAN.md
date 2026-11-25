# GNU Octave VS Code Extension — Plan
 
## Goal
Use GNU Octave from VS Code the way the MATLAB extension works: F5 to run, breakpoint debugging, and agent-friendly editing. An MCP server comes later.
 
## Decisions (2026-11-15)
- **One new self-contained extension** in TypeScript. Reuse MIT-licensed parts where the licence allows (e.g. the apjanke/vscode-octave-hacking grammar and outline).
- **Target platform: Windows.**
- **Persistent session:** one long-lived Octave process shared by Run, Run Selection, the terminal and the debugger. The workspace is kept between runs, like MATLAB.
- **v1 scope:** run file / selection / `%%` section, plus breakpoint debugging.
## Existing work reviewed
| Project | What it offers | Use |
|---|---|---|
| apjanke/vscode-octave-hacking (MIT) | Highlighting, outline, snippets; no debugging | Reuse grammar/outline |
| Paulo Silva — Octave Debugger | DAP adapter spawning octave-cli | Reference for the dbstop/dbstep mapping |
| LucasFA/vscode-octave (fork of leafvmaple) | Run file/line by sending text to a terminal | Reference for keybindings |
| LucasFA/octave-lsp (Rust) | Unfinished LSP | Not usable yet |
| TomiVidal99/mlang (TS) | Unfinished LSP | Maybe later |
| tjhu/vscode-octave-debug | Basic DAP, 1D variables only | Reference only |
 
The gap: every existing tool starts its own process. None of them offers a shared persistent session.
 
## Architecture
1. **Session manager:** an `octave-cli` (or `octave --no-gui`) child process behind a VS Code Pseudoterminal. Commands are wrapped with sentinel markers so we can tell when each finishes. Supports interrupt.
2. **Run commands:** run file (`run`/`source`), run selection/line, run section (`%%`). A ▶ button in the editor title bar. F5 runs with breakpoints honoured.
3. **Debug adapter (inline DAP)** on the same session. Breakpoints map to `dbstop`/`dbclear`, stepping to `dbstep`/`dbstep in`/`dbstep out`/`dbcont`/`dbquit`, the call stack to `dbstack`, and variables to `whos` plus value display per frame (`dbup`/`dbdown`). The debug console evaluates in the current frame.
4. **Language basics:** TextMate grammar, outline/document symbols, `%%` section folding.
5. **Later:** hover help and completion from the live session, a workspace view, plots, an MCP server reusing the session manager.
## Windows-specific risks to verify
- Interrupting a running command (Ctrl+C): signals to a child process on Windows are unreliable.
- Plot windows: which graphics toolkit works with octave-cli vs `octave --no-gui`.
- Non-ASCII paths (a known Octave CLI limitation noted in LucasFA's README).
- Locating the executable under `C:\Program Files\GNU Octave\Octave-x.y.z\mingw64\bin`.
## Phases
0. Evaluate existing repos and licences
1. Session manager + run commands
2. Debug adapter
3. Language basics polish
4. Package as .vsix
5. MCP server
6. Workspace view (variables of the live session, like MATLAB's Workspace browser)

## To do later
- **Agent skills for the MCP server** (first version: `agent-toolkit/`, plugin `octave-core` with run-code, debugging, testing and review-code skills; next: try them with real agents, add evals): skills (e.g. a Claude Code skill / plugin) that tell agents when and how to use the Octave MCP tools: prefer `octave_run` in the live session over spawning `octave-cli`, check `octave_status` first, inspect with `octave_workspace` / `octave_get_value`, use breakpoints and `octave_debug` to investigate, and interrupt long runs.
- Plots (figures in VS Code).
