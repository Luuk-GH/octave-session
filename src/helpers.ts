import * as fs from 'fs';
import * as path from 'path';

/**
 * Octave functions the extension puts on the path (in a temp folder) for the debugger and Run File.
 * Running inside functions keeps their temporaries out of the user's workspace.
 *
 * Machine-readable output uses records: char(29) <fields separated by char(31)> char(30).
 */
export const REC_START = '\x1d', FIELD_SEP = '\x1f', REC_END = '\x1e';

const HELPERS: Record<string, string> = {
  // Whether two paths name the same file/folder. is_same_file only exists since Octave 7.
  '__vsc_same__.m': String.raw`function tf = __vsc_same__(a, b)
  % VS Code: compare two paths after resolving them (case-insensitive on Windows).
  ca = canonicalize_file_name(a);
  cb = canonicalize_file_name(b);
  if (isempty(ca))
    ca = a;
  end
  if (isempty(cb))
    cb = b;
  end
  ca = regexprep(strrep(ca, "\\", "/"), "/+$", "");
  cb = regexprep(strrep(cb, "\\", "/"), "/+$", "");
  if (ispc())
    tf = strcmpi(ca, cb);
  else
    tf = strcmp(ca, cb);
  end
end
`,

  // Run a script by name in the base workspace, from its own folder (like run()), so breakpoints set
  // with dbstop apply: run()/source() re-parse the file and lose them.
  '__vsc_run__.m': String.raw`function __vsc_run__(file)
  % VS Code: run a script file in the base workspace with breakpoints honoured.
  [d, name] = fileparts(file);
  old = pwd();
  if (!__vsc_same__(d, old))
    cd(d);
    % onCleanup (not unwind_protect) so the folder is also restored after dbquit.
    restore = onCleanup(@() back(old, d));
  end
  evalin("base", name);
end

function back(old, d)
  % Return to the previous folder unless the script changed folder itself (like run()).
  if (__vsc_same__(pwd(), d) && exist(old, "dir"))
    cd(old);
  end
end
`,

  // Replace the breakpoints of one file. Prints one BP record (requested line, actual line or -1) per line.
  '__vsc_bp__.m': String.raw`function __vsc_bp__(file, lines, doclear)
  % VS Code: set the breakpoints of FILE to LINES. DOCLEAR drops the cached parse first (file was saved).
  [d, name] = fileparts(file);
  added = false;
  try
    w = which(name);
    if (isempty(w) || !__vsc_same__(w, file))
      addpath(d);
      added = true;
    end
    if (doclear && !isdebugmode())
      clear("-f", name);
    end
    try
      dbclear(name);
    catch
    end
    for l = lines(:)'
      try
        a = dbstop(name, num2str(l));
        if (isempty(a))
          a = -1;
        end
      catch
        a = -1;
      end
      printf("%sBP%s%d%s%d%s", char(29), char(31), l, char(31), a(1), char(30));
    end
  catch err
    printf("%sERR%s%s%s", char(29), char(31), err.message, char(30));
  end
  if (added)
    rmpath(d);
  end
end
`,

  // The call stack (without this helper's own frame) and the index of the selected frame.
  '__vsc_stack__.m': String.raw`function __vsc_stack__()
  % VS Code: print the call stack as records.
  [st, idx] = dbstack(1);
  for i = 1:numel(st)
    printf("%sF%s%s%s%s%s%d%s%d%s", char(29), char(31), st(i).file, char(31), st(i).name, char(31), ...
           st(i).line, char(31), st(i).column, char(30));
  end
  printf("%sIDX%s%d%s", char(29), char(31), idx, char(30));
end
`,

  // Completion candidates (what Octave's own command line would offer), with a kind per name:
  // v = variable, f = struct field, k = keyword, F = function/script/other.
  '__vsc_complete__.m': String.raw`function __vsc_complete__(prefix)
  % VS Code: completion candidates for PREFIX as records (kind, name).
  % Evaluated in the caller so variables and fields of the user's workspace (or debug frame) are seen.
  m = evalin("caller", sprintf("completion_matches('%s')", strrep(prefix, "'", "''")));
  vars = evalin("caller", "who");
  for i = 1:rows(m)
    name = strtrim(strrep(m(i,:), char(0), ""));
    if (isempty(name))
      continue;
    end
    if (any(name == "."))
      kind = "f";
    elseif (any(strcmp(name, vars)))
      kind = "v";
    elseif (iskeyword(name))
      kind = "k";
    else
      kind = "F";
    end
    printf("%s%s%s%s%s", char(29), kind, char(31), name, char(30));
  end
end
`,

  // Usage lines and a short description of a function, for signature help and completion details.
  '__vsc_sig__.m': String.raw`function __vsc_sig__(name)
  % VS Code: help-based signatures of NAME (FMT, SIG lines for texinfo, FILE for m-files, DOC summary).
  try
    [t, fmt] = get_help_text(name);
  catch
    return;
  end
  printf("%sFMT%s%s%s", char(29), char(31), fmt, char(30));
  if (strcmp(fmt, "Not found"))
    return;
  end
  lines = strsplit(t, "\n");
  doc = {};
  started = false;
  for i = 1:numel(lines)
    l = lines{i};
    if (!isempty(regexp(l, '^\s*@deftypefnx?\s', 'once')))
      printf("%sSIG%s%s%s", char(29), char(31), strtrim(l), char(30));
      started = true;
    elseif (strcmp(fmt, "texinfo") && !started)
      continue;
    elseif (isempty(strtrim(l)) || !isempty(regexp(l, '^\s*@(end|seealso|example|group)', 'once')))
      if (!isempty(doc))
        break;
      end
    else
      doc{end+1} = strtrim(l);
    end
  end
  printf("%sDOC%s%s%s", char(29), char(31), strjoin(doc, " "), char(30));
  w = which(name);
  if (!isempty(w) && exist(w, "file") == 2 && numel(w) > 2 && strcmpi(w(end-1:end), ".m"))
    printf("%sFILE%s%s%s", char(29), char(31), w, char(30));
  end
end
`,

  // Display text of an expression, as the Command Window would show it, without touching the caller's `ans`.
  '__vsc_show__.m': String.raw`function __vsc_show__(expr)
  % VS Code: print "name = value" for EXPR evaluated in the caller (errors as an ERR record).
  try
    __v__ = evalin("caller", expr);
  catch err
    % Caught here so "dbstop if error" doesn't stop inside this helper.
    printf("%sERR%s%s%s", char(29), char(31), err.message, char(30));
    return;
  end
  if (isempty(regexp(expr, '^[A-Za-z]\w*$', 'once')))
    __n__ = "ans";
  else
    __n__ = expr;
  end
  eval([__n__ " = __v__"]);
end
`,

  // edit/open: open files in the VS Code editor. Shadows Octave's edit while the extension's session runs.
  // The OPEN record is taken out of the output by the extension, which opens the file.
  'edit.m': String.raw`function edit (varargin)
  % VS Code: open files (or functions, by name) in the VS Code editor.
  % edit             opens a new untitled Octave file
  % edit NAME ...    opens NAME (file path, script or function on the path); creates NAME.m if not found
  if (nargin == 0)
    __vsc_open_record__ ("");
    return;
  end
  if (ischar (varargin{1}) && any (strcmpi (varargin{1}, {"editor", "home", "author", "email", "license", "mode", "get"})))
    warning ("edit: '%s' is not used: files open in VS Code", varargin{1});
    return;
  end
  for i = 1:nargin
    name = varargin{i};
    if (! ischar (name) || isempty (name))
      error ("edit: file name must be a non-empty string");
    end
    [f, msg] = target (strtrim (name));
    if (! isempty (msg))
      error ("edit: %s", msg);
    end
    __vsc_open_record__ (f);
  end
end

function [f, msg] = target (name)
  f = "";
  msg = "";
  name = tilde_expand (name);
  if (isfile_ (name))
    f = make_absolute_filename (name);
    return;
  end
  [d, n, e] = fileparts (name);
  if (isempty (e) && isfile_ ([name ".m"]))
    f = make_absolute_filename ([name ".m"]);
    return;
  end
  if (isempty (d) && (isempty (e) || strcmpi (e, ".m")))
    w = which (n);
    if (! isempty (w) && isfile_ (w))
      f = w;
      return;
    end
    if (any (exist (n) == [3 5]))
      msg = sprintf ("'%s' is a built-in or compiled function and has no .m source", n);
      return;
    end
  end
  if (isempty (e))
    name = [name ".m"];
  end
  f = make_absolute_filename (name);
  [fd, msg] = fopen (f, "w");
  if (fd < 0)
    msg = sprintf ("cannot create %s: %s", f, msg);
    return;
  end
  fclose (fd);
  printf ("Created %s\n", f);
end

function tf = isfile_ (p)
  [st, err] = stat (p);
  tf = (err == 0 && ! S_ISDIR (st.mode));
end
`,

  'open.m': String.raw`function varargout = open (file)
  % VS Code: open .m files and functions in the VS Code editor; other files as Octave's open does
  % (.mat loads into the workspace, .ofig opens a figure, the rest in the default Windows app).
  if (nargin < 1)
    print_usage ();
  end
  if (! ischar (file))
    error ("open: FILE must be a string");
  end
  [d, n, e] = fileparts (file);
  if (strcmpi (e, ".m") || (isempty (e) && (exist ([file ".m"], "file") || (isempty (d) && exist (file) == 2))))
    edit (file);
    return;
  end
  % Hand everything else to Octave's own open (shadowed by this file while the helpers are on the path).
  here = fileparts (mfilename ("fullpath"));
  s = warning ("off", "Octave:shadowed-function");
  rmpath (here);
  unwind_protect
    if (nargout > 0)
      varargout{1} = open (file);
    else
      open (file);
    end
  unwind_protect_cleanup
    addpath (here);
    warning (s);
  end_unwind_protect
end
`,

  '__vsc_open_record__.m': String.raw`function __vsc_open_record__ (f)
  % VS Code: ask the extension to open file F in the editor ("" = new untitled file).
  printf ("%sOPEN%s%s%s", char (29), char (31), f, char (30));
  fflush (stdout);
end
`,

  // input / yes_or_no / pause read from stdin while a command runs. These wrappers first print an INPUT record,
  // so the Command Window knows Octave is waiting for a line (instead of looking busy forever). pause() with no
  // argument normally waits for a key on Octave's hidden console, which nobody can reach; here it waits for Enter.
  '__vsc_input_record__.m': String.raw`function __vsc_input_record__ (source)
  % VS Code: tell the extension that Octave now reads a line from stdin (SOURCE: input, yes_or_no, pause).
  fflush (stdout);
  printf ("%sINPUT%s%s%s", char (29), char (31), source, char (30));
  fflush (stdout);
end
`,

  // clc / home print nothing on a pipe; these ask the extension to clear the Command Window views instead.
  'clc.m': String.raw`function clc ()
  % -*- texinfo -*-
  % @deftypefn {} {} clc ()
  % Clear the Command Window (VS Code wrapper of Octave's clc).
  % @end deftypefn
  printf ("%sCLEAR%s%s", char (29), char (31), char (30));
  fflush (stdout);
end
`,

  'home.m': String.raw`function home ()
  % -*- texinfo -*-
  % @deftypefn {} {} home ()
  % Clear the Command Window (VS Code wrapper of Octave's home).
  % @end deftypefn
  clc ();
end
`,

  'input.m': String.raw`function varargout = input (varargin)
  % -*- texinfo -*-
  % @deftypefn  {} {@var{ans} =} input (@var{prompt})
  % @deftypefnx {} {@var{ans} =} input (@var{prompt}, "s")
  % Print @var{prompt} and wait for user input.
  % The string entered is evaluated as an expression; with "s" it is returned as a string.
  % (Octave's built-in input, wrapped by VS Code so the Command Window knows Octave is waiting.)
  % @end deftypefn
  __vsc_input_record__ ("input");
  [varargout{1:max (nargout, 1)}] = builtin ("input", varargin{:});
end
`,

  'yes_or_no.m': String.raw`function varargout = yes_or_no (varargin)
  % -*- texinfo -*-
  % @deftypefn {} {@var{ans} =} yes_or_no ("@var{prompt}")
  % Ask the user a yes-or-no question.
  % Return logical true if the answer is yes or false if the answer is no.
  % (Octave's built-in yes_or_no, wrapped by VS Code so the Command Window knows Octave is waiting.)
  % @end deftypefn
  __vsc_input_record__ ("yes_or_no");
  [varargout{1:max (nargout, 1)}] = builtin ("yes_or_no", varargin{:});
end
`,

  'pause.m': String.raw`function varargout = pause (varargin)
  % -*- texinfo -*-
  % @deftypefn  {} {} pause ()
  % @deftypefnx {} {} pause (@var{n})
  % @deftypefnx {} {@var{old_state} =} pause ("on")
  % @deftypefnx {} {@var{old_state} =} pause ("off")
  % @deftypefnx {} {@var{old_state} =} pause ("query")
  % Suspend the execution of the program or change the state of the pause function.
  % Without an argument (or with Inf) the program waits until Enter is pressed in the Command Window.
  % (Octave's built-in pause, wrapped by VS Code.)
  % @end deftypefn
  forever = nargin == 0 || (nargin == 1 && isnumeric (varargin{1}) && isscalar (varargin{1}) && isinf (varargin{1}));
  if (forever && nargout == 0)
    if (strcmp (builtin ("pause", "query"), "off"))
      return;
    end
    __vsc_input_record__ ("pause");
    builtin ("input", "", "s");
    return;
  end
  [varargout{1:nargout}] = builtin ("pause", varargin{:});
end
`,

  // Variables of the calling frame, children of an expression, or the expression itself.
  '__vsc_vars__.m': String.raw`function __vsc_vars__(expr, mode)
  % VS Code: describe variables as records (name, value, type, child expression, child count).
  if (nargin < 2)
    mode = "children";
  end
  if (nargin < 1 || isempty(expr))
    names = evalin("caller", "who");
    for i = 1:numel(names)
      try
        rec(names{i}, names{i}, evalin("caller", names{i}));
      catch
      end
    end
    return;
  end
  if (strcmp(mode, "hover"))
    root = regexp(expr, '^[A-Za-z]\w*', 'match', 'once');
    if (isempty(root) || !evalin("caller", sprintf("exist('%s', 'var')", root)))
      return;
    end
  end
  try
    v = evalin("caller", expr);
  catch err
    % Caught here so "dbstop if error" doesn't stop inside this helper.
    printf("%sERR%s%s%s", char(29), char(31), err.message, char(30));
    return;
  end
  if (!strcmp(mode, "children"))
    rec("", expr, v);
    return;
  end
  b = expr;
  if (isempty(regexp(expr, '^[A-Za-z]\w*(\.[A-Za-z]\w*|\([^()]*\)|\{[^{}]*\})*$', 'once')))
    b = ["(" expr ")"];
  end
  n = 1000;
  if (isstruct(v) && isscalar(v))
    f = fieldnames(v);
    for i = 1:numel(f)
      rec(f{i}, [b "." f{i}], v.(f{i}));
    end
  elseif (isstruct(v))
    for i = 1:min(numel(v), n)
      rec(sprintf("(%d)", i), sprintf("%s(%d)", b, i), v(i));
    end
  elseif (iscell(v))
    for i = 1:min(numel(v), n)
      rec(sprintf("{%d}", i), sprintf("%s{%d}", b, i), v{i});
    end
  elseif (ndims(v) > 2)
    for k = 1:min(prod(size(v)(3:end)), n)
      rec(sprintf("(:,:,%d)", k), sprintf("%s(:,:,%d)", b, k), v(:,:,k));
    end
  elseif (rows(v) > 1)
    for i = 1:min(rows(v), n)
      rec(sprintf("(%d,:)", i), sprintf("%s(%d,:)", b, i), v(i,:));
    end
  else
    for i = 1:min(numel(v), n)
      rec(sprintf("(%d)", i), sprintf("%s(%d)", b, i), v(i));
    end
  end
end

function rec(name, expr, v)
  sz = size(v);
  dims = sprintf("%dx", sz);
  dims = dims(1:end-1);
  cls = class(v);
  kids = 0;
  if (isstruct(v))
    if (isscalar(v))
      kids = numel(fieldnames(v));
      val = sprintf("%s struct", dims);
    else
      kids = numel(v);
      val = sprintf("%s struct array", dims);
    end
  elseif (iscell(v))
    kids = numel(v);
    val = sprintf("{%s cell}", dims);
  elseif (ischar(v) && ndims(v) == 2 && rows(v) <= 1)
    if (numel(v) > 500)
      val = ['"' v(1:500) '..."'];
    else
      val = ['"' v '"'];
    end
  elseif (isnumeric(v) || islogical(v) || ischar(v))
    if (isempty(v))
      val = sprintf("[](%s)", dims);
    elseif (ndims(v) == 2 && numel(v) <= 100)
      val = mat2str(v);
    else
      val = sprintf("%s %s", dims, cls);
    end
    if (numel(v) > 1)
      if (ndims(v) > 2)
        kids = prod(sz(3:end));
      elseif (rows(v) > 1)
        kids = rows(v);
      else
        kids = numel(v);
      end
    end
  elseif (is_function_handle(v))
    val = func2str(v);
  else
    try
      val = strtrim(disp(v));
    catch
      val = sprintf("%s %s", dims, cls);
    end
  end
  val = strrep(strrep(val, "\r", ""), "\n", " ");
  val(val == char(29) | val == char(30) | val == char(31)) = [];  % record separators
  if (numel(val) > 2000)
    val = [val(1:2000) "..."];
  end
  printf("%s%s%s%s%s%s %s%s%s%s%d%s", char(29), name, char(31), val, char(31), dims, cls, char(31), ...
         expr, char(31), kids, char(30));
end
`,
};

/** Write the helper functions into `dir` (created if needed) and return it. */
export function writeHelpers(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(HELPERS)) {
    fs.writeFileSync(path.join(dir, name), src, 'utf8');
  }
  return dir;
}

/** Parse helper output into records (arrays of fields). Text outside records is ignored. */
export function parseRecords(text: string): string[][] {
  const out: string[][] = [];
  const re = /\x1d([^\x1d\x1e]*)\x1e/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { out.push(m[1].split(FIELD_SEP)); }
  return out;
}

/** Quote any text as an Octave single-quoted string (no escape processing). */
export function octaveLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
