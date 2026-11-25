---
name: octave-run-code
description: Run GNU Octave code, scripts and functions in the user's live Octave session in VS Code through the octave MCP tools. Use whenever a task involves executing Octave or MATLAB-style code (.m files), checking a result, computing something in Octave, inspecting variables, or looking up an Octave function's help — e.g. "run this script", "what does x contain", "try this in Octave", "how do I call interp1". Do not start a separate octave/octave-cli process from a shell when these tools are available.
metadata:
  version: "0.1"
---

# Run code in the live Octave session

The `octave_*` MCP tools drive the **user's own Octave session** inside VS Code (the *Octave* Command Window).
It is shared: what you run is echoed in their Command Window, and variables you create stay in the workspace
they see. Treat it like sitting at someone else's keyboard.

## When to use

- Running Octave code, a `.m` script, or calling a function to check its output.
- Inspecting variables the user created ("what's in `results`?").
- Looking up the usage of an Octave function or one of the user's functions.

## When NOT to use

- The tools are not available (server not enabled): tell the user to run **Octave: Set Up MCP Server** in
  VS Code rather than silently falling back to a shell.
- Finding and fixing a bug: use the `octave-debugging` skill. Writing or running tests: `octave-testing`.
  Reviewing code without running it: `octave-review-code`.

## Rules

1. **Never spawn `octave`, `octave-cli` or `octave-gui` from a terminal** for this work. That starts a second,
   empty Octave that does not share the user's variables, path or breakpoints.
2. **Check `octave_status` first** in a new task. It never starts a session. If the state is `busy`, wait or ask
   before calling `octave_interrupt`; if it is `debug`, the user (or a previous run) is stopped at a breakpoint —
   don't quit their debugging session without asking.
3. **Don't destroy the user's state.** No `clear`, `clear all`, `clc`, `close all`, `cd` to unrelated folders,
   `pkg unload`, or path changes unless asked. Don't overwrite existing variables: check `octave_workspace` and
   pick distinctive names (e.g. `tmp_agent_result`) for scratch values, and clear them again in the same
   `octave_run` call (`...; clear tmp_agent_result`) unless the user wants to see them.
4. **Leave the path and folder as they were.** `octave_status` shows the current folder; functions there are
   found without `addpath`. If you must call a function from another folder, `addpath` it and `rmpath` it
   again in the same call.
5. **Read without side effects.** Use `octave_get_value`, `octave_workspace` and `octave_help` to look things
   up: they are hidden queries and don't clutter the Command Window. `octave_get_value` must only evaluate
   expressions without side effects (no assignments, plots, file writes).
6. **One run at a time.** A second `octave_run` while one is running fails.

## Workflow

1. `octave_status` — state, Octave version, current folder.
2. Gather context without running anything: `octave_workspace`, `octave_get_value` for specific variables,
   `octave_help` for unfamiliar functions (Octave and MATLAB differ in places; check rather than assume).
3. Run:
   - A snippet: `octave_run` with `code`. Multi-line code is fine; it runs as one block in the base workspace.
     End statements with `;` unless you want the value printed — output is returned to you and shown to the user.
   - A script file: `octave_run_file` with the **absolute** path. It runs from the file's folder (like Run File)
     with the user's breakpoints active. For a function file, call the function with `octave_run` instead
     (its folder must be on the path or be the current folder).
4. Read the result:
   - `isError` / lines starting with `error:` mean the code failed; the text includes Octave's message and
     `error: called from` lines with file and line.
   - A note that Octave **stopped in the debugger** means a breakpoint or `keyboard` was hit. Continue with
     `octave_debug` (`continue`, `step`, … or `quit`) — see `octave-debugging`. Don't leave it stopped.
   - A **timeout** note means the code is still running. Poll `octave_status`, or call `octave_interrupt`
     if it is stuck. Raise `timeout_seconds` (max 600) for known long runs instead of interrupting them.
5. Report what you ran and what came out. If you left variables in the workspace on purpose, say which.

## Octave specifics worth remembering

- Octave accepts MATLAB syntax plus extras (`#` comments, `!=`, `++`, `endif`/`endfor`, double-quoted strings
  with escapes). If the user's code must also run in MATLAB, write MATLAB-compatible code.
- Figures open in separate Octave windows on the user's desktop; you cannot see them. Report numbers instead
  (e.g. compute and print the values you would read off a plot), and don't open dozens of figures.
- Packages must be loaded (`pkg load signal`) before their functions exist; check with `pkg list` before
  assuming a package is installed, and ask before installing one.
- `ans` is shared too: don't rely on it across calls; assign results to named variables.
