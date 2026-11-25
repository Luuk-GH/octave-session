---
name: octave-debugging
description: Find and fix bugs in GNU Octave / MATLAB-style .m code using the user's live Octave session in VS Code — run to reproduce, read the error and call stack, set breakpoints, step through code and inspect variables with the octave MCP tools. Use when the user reports an error message or stack trace from Octave, wrong or unexpected results, NaN/Inf/size-mismatch problems, code that hangs, or asks to "debug", "find out why", "step through" Octave code.
metadata:
  version: "0.1"
---

# Debug Octave code

Debug with evidence from the live session, not by guessing from the source. The `octave_*` tools share the
user's Octave session and their VS Code debugger: breakpoints you add appear in their editor gutter and
stepping moves the debug view they are looking at.

## When to use

- An error from Octave (`error: ...`, `called from`), wrong output, unexpected sizes, NaN/Inf, a hang.

## When NOT to use

- Just running code or checking a value: `octave-run-code`. Writing tests: `octave-testing`.
  Style or quality review without a concrete failure: `octave-review-code`.

## Workflow

1. **Orient.** `octave_status`. If Octave is already in `debug` state, the user may be mid-session: ask before
   quitting it, or work within it (inspect, step) if that is what they asked for.
2. **Reproduce.** Run the failing script (`octave_run_file`, absolute path) or the failing call (`octave_run`).
   Get the exact error text. If you cannot reproduce it, ask for the inputs or steps instead of guessing.
3. **Read the error.** The message plus the `error: called from` lines give function, file and line of each
   frame, innermost first. Open those lines in the source. Common Octave messages:
   - `nonconformant arguments (op1 is AxB, op2 is CxD)` — size mismatch; check orientation (row vs column)
     and whether `*` should be `.*`.
   - `a(5): out of bound 3 (dimensions are 1x3)` — off-by-one, or an empty result of `find` used as an index.
   - `a(0): subscripts must be either integers 1 to (2^63)-1 or logicals` — 0-based thinking or a
     non-integer index computed from data.
   - `'x' undefined` — typo, variable set only in one branch, or a function not on the path.
   - `binary operator '+' not implemented for 'cell' by 'double' operations` (and similar) — `{}` vs `()`
     indexing of a cell array.
4. **Inspect state at the failure.** Pick one:
   - *Stop on the error:* run `dbstop if error` with `octave_run`, then reproduce. Octave stops in the
     debugger at the failing line with that frame's variables live. Afterwards run `dbclear if error`
     (unless the user had it on — the VS Code *Errors* breakpoint does the same thing).
   - *Stop before it:* `octave_breakpoints` with `action: "add"`, absolute `file` and 1-based `line` (a line
     with an executable statement), then reproduce.
   Then, while stopped:
   - `octave_status` shows the call stack and stop location.
   - `octave_workspace` lists the variables of the current frame; `octave_get_value` evaluates expressions in
     it (`size(A)`, `class(x)`, `any(isnan(v(:)))`, `A(2,:)`) — side-effect-free only.
   - `octave_debug` with `step` (next line), `step_in` (into a call), `step_out` (finish this function),
     `continue` (to the next breakpoint or the end). Each returns the new location.
5. **Form one hypothesis and test it.** State what you expect a value to be, check it, and narrow down. Prefer
   evaluating a small expression over adding `disp` calls to the user's files.
6. **Clean up the debug session.** `octave_debug` with `quit` to leave the debugger (this aborts the run).
   Remove the breakpoints **you** added (`octave_breakpoints` `remove` with file and line); keep the user's own.
7. **Fix and verify.** Make the minimal change in the source, then re-run the original reproduction and show it
   now passes. If there are tests (`%!test` blocks or a test script), run them too (`octave-testing`). For a
   wrong-result bug, add a test that would have caught it when the user wants tests.

## Hangs and long runs

- If a run times out, the code keeps running. Check `octave_status`; if it is stuck, `octave_interrupt`
  (like Ctrl+C) aborts it and keeps the workspace.
- To see where it loops, add a breakpoint inside the loop body and re-run, or interrupt and inspect loop
  variables that the run left in the base workspace (scripts only).

## Rules

- Don't leave Octave stopped in the debugger or with breakpoints you added when you finish.
- Don't `clear` the workspace to "start fresh" — the user's variables may be the reproduction.
- Octave runs files as saved on disk: save edits before running or setting breakpoints in them.
- Pause is not available on Windows; you can only stop at breakpoints or interrupt.
