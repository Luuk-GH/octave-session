---
name: octave-testing
description: Write and run tests for GNU Octave .m code with Octave's built-in test framework (%!test, %!assert, %!error blocks, test(), oruntests) in the user's live Octave session via the octave MCP tools. Use when asked to add, write, run or fix tests for Octave functions, check that a change didn't break anything, or set up a regression test for a bug.
metadata:
  version: "0.1"
---

# Test Octave code

Octave has its own test framework, different from MATLAB's `matlab.unittest`/`runtests` (which Octave does
not support). Tests live **in the function file itself**, in `%!` blocks after the code, and run with
`test("name")`. Use it unless the project already uses something else (e.g. MOxUnit or plain test
scripts) — look for existing `%!` blocks or a `tests/` folder first and follow that.

## When to use

- Writing tests for a function, adding a regression test after a bug fix, running a project's tests.

## When NOT to use

- Finding the cause of a failure: `octave-debugging`. Just running code: `octave-run-code`.

## Test block syntax

Blocks start with `%!` at the beginning of a line, after the function's code (below its `end`):

```octave
function y = clamp (x, lo, hi)
  y = min (max (x, lo), hi);
end

%!assert (clamp (5, 0, 3), 3)
%!assert (clamp ([-1 2], 0, 3), [0 2])
%!assert (clamp (0.1+0.2, 0, 1), 0.3, eps)      # tolerance: absolute; negative value = relative

%!test
%! y = clamp (magic (3), 2, 8);
%! assert (size (y), [3 3]);
%! assert (all (y(:) >= 2 & y(:) <= 8));

%!shared lo, hi                                 # variables visible to the blocks after it
%! lo = 0; hi = 1;
%!assert (clamp (2, lo, hi), 1)

%!error <undefined> clamp ()                    # expects an error whose message matches the regexp
%!warning <careful> warning ("careful")         # expects a warning matching the regexp
```

Notes: `%!test` bodies are separate functions (their variables don't leak between blocks; use `%!shared`).
`assert (observed, expected, tol)` compares sizes, classes and values and prints a table of mismatches.
`%!xtest` marks a known failure (reported, not counted as failed); `%!testif HAVE_X` and `%!function`
(helpers for the tests) also exist — see `octave_help test`. `%!` lines are comments to Octave, so they
never affect normal runs.

## Workflow

1. `octave_status`; read the function and any existing tests. Ask what behaviour matters if unclear.
2. Write tests: the normal case, edge cases (empty input, scalar vs vector vs matrix, NaN/Inf, negative,
   integer types), and error cases (`%!error`). One idea per `%!assert`/`%!test`. Use a tolerance for
   floating-point results. For a bug fix, first add a test that fails on the bug.
3. Save the file, then run with `octave_run` (the function's folder must be the current folder or on the path):
   ```octave
   [tmp_npass, tmp_ntotal] = test ("clamp"); printf ("%d of %d passed\n", tmp_npass, tmp_ntotal); clear tmp_npass tmp_ntotal
   ```
   (The counts go into scratch variables that are cleared in the same call, so the user's workspace is left
   as it was.)
   Failures print `!!!!! test failed` with the block and the assert table. Run `test ("clamp", "verbose")`
   to see every block. A whole folder: `oruntests ("C:/path/to/folder")` (Octave 9+; older versions call it
   `runtests`).
4. Fix the code or the test — decide which is wrong; never weaken a test just to make it pass without saying
   so. Re-run until it passes.
5. Report: number passed out of total, any known failures (`xtest`) and anything left failing.

## Rules

- Tests must not depend on or change the user's workspace (they run in their own scope; keep it that way —
  no `evalin`, no globals unless the code uses them).
- Don't leave figures or files behind: close what tests open (`unwind_protect` … `unwind_protect_cleanup`)
  and write temp files with `tempname ()`.
- Keep test runs fast; mark slow tests clearly and ask before adding long-running ones.
