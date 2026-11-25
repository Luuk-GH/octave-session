---
name: octave-review-code
description: Review GNU Octave / MATLAB-style .m code for correctness risks, performance, readability and Octave/MATLAB portability, using the live Octave session (octave MCP tools) for syntax checks and help lookups. Use when asked to review, critique, clean up or check Octave code, a pull request with .m files, or whether code will run in both Octave and MATLAB. Read-only unless the user asks for changes.
metadata:
  version: "0.1"
---

# Review Octave code

A review reports problems ranked by severity; it does not change behaviour. Only edit files when the user
asks for fixes, and then keep fixes separate from the review.

## When NOT to use

- A concrete error or wrong result: `octave-debugging`. Writing tests: `octave-testing`.

## Workflow

1. **Scope.** Which files, and whether the code must also run in MATLAB (ask if it matters and is unclear).
2. **Syntax check** each file without running it, with `octave_run`:
   ```octave
   __parse_file__ ("C:/abs/path/file.m")
   ```
   No output means it parses; otherwise you get `syntax error near line L, column C`. (Octave has no
   `checkcode`/`mlint`; this internal function only checks syntax. Don't run scripts just to "check" them.)
3. **Read the code** against the checklist below. Use `octave_help` to confirm how a function behaves in
   Octave instead of assuming MATLAB behaviour.
4. **Confirm every correctness finding by running it** before you report it. Reasoning about Octave semantics
   from memory is error-prone (truth of arrays in `if`, broadcasting, empty results, integer rounding). For
   each suspected wrong result, call the function or evaluate the expression on a small input with
   `octave_run` and quote the actual output in the finding, e.g. "`moving_avg (1:5, 2)` returns
   `[1.5 2.5 3.5]`, expected four values". Use scratch names and clear them afterwards; only call functions,
   never run scripts or code that writes files or changes state. If you can't confirm it, list it as a
   question, not an error. Existing tests (`%!` blocks): run `test ("name")` and include the result.
5. **Report** grouped by severity — *errors* (wrong results, crashes), *warnings* (fragile, slow, portability),
   *suggestions* (readability) — each with file:line, the problem, and a concrete fix. Say what you did not
   check.

## Checklist

**Correctness**
- Matrix vs element-wise operators (`*` vs `.*`, `/` vs `./`, `^` vs `.^`); `'` (conjugate transpose) where
  `.'` is meant on complex data.
- Row/column orientation assumptions; `length` on matrices (it is the largest dimension); `numel` vs `size`.
- Indexing: off-by-one, `end`, empty results of `find`, logical masks of the wrong size, `{}` vs `()` on cells.
- Floating-point equality (`==` on computed values) instead of a tolerance; integer-class saturation and
  rounding (`int8(200)` is 127).
- Conditions on arrays: `if (v)` is true only if `v` is non-empty and **all** its elements are non-zero, so
  `if (v == 0)` means "all elements are zero" and an empty `v` is false. Intent is usually clearer with
  explicit `all ()`/`any ()`. `&&`/`||` on non-scalar operands: Octave silently applies `all ()`, MATLAB errors.
- Variables defined only in some branches; shadowing of built-ins (`sum = ...`, `i`, `j`, `e`, `eps`).
- Missing input validation for public functions (`nargin`, `validateattributes`, `print_usage ()`).

**Performance**
- Arrays grown inside loops — preallocate (`zeros`, `cell`) or vectorise.
- Loops that are one vectorised expression (`sum`, `cumsum`, logical indexing, `bsxfun`/broadcasting).
- Repeated work inside loops (invariant computations, repeated file reads, `eval`).

**Robustness and style**
- `eval`, `evalin`, `assignin`, `global`: high severity unless clearly justified.
- Hard-coded paths and magic numbers; missing `fclose`/cleanup (use `unwind_protect` or `onCleanup`).
- A help comment block right after each public `function` line (the first line is what `help`/`lookfor` show).
- Clear names; functions short enough to follow; consistent indentation.

**Octave/MATLAB portability** (only when the code must run in both)
- Octave-only syntax: `#` and `#{ }#` comments, `!`/`!=`, `++`/`+=`, `endif`/`endwhile`/`endfunction`,
  `"…"` strings with backslash escapes (in MATLAB `"…"` makes a `string` object), `printf`/`puts`,
  `unwind_protect`, default-value tricks.
- Functions that exist in only one of them, or differ (check with `octave_help`; packages such as `signal`
  need `pkg load` in Octave but a toolbox licence in MATLAB).
- Toolbox-dependent calls: list them so the user knows the dependencies.
