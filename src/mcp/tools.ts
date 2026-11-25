// Tool definitions (names, descriptions for the LLM, JSON Schemas) and the server instructions. No VS Code dependency.
import type { ToolDef } from './protocol';

export const SERVER_INSTRUCTIONS =
  'This is the user\'s live GNU Octave session in VS Code, shared with them: code you run with octave_run appears in ' +
  'their Command Window, and variables you create stay in the workspace they see (and the other way round). ' +
  'Do not assume a clean workspace, and avoid clear/clc/close all or other destructive commands unless asked. ' +
  'Run one thing at a time: if Octave is busy, wait or use octave_interrupt. A run that hits a breakpoint leaves ' +
  'Octave stopped in the debugger; use octave_debug to continue, step or quit. Use octave_get_value, octave_workspace and ' +
  'octave_help to look things up without echoing anything in the Command Window.';

const timeoutProp = {
  type: 'number',
  description: 'How long to wait for the run to finish, in seconds (default 60, max 600). On timeout the code keeps running; ' +
    'you get the output so far and can poll octave_status or call octave_interrupt.',
  minimum: 1,
  maximum: 600,
};

export const TOOLS: ToolDef[] = [
  {
    name: 'octave_run',
    description:
      'Run Octave code in the base workspace of the user\'s live, shared session. The code is echoed in their Command Window ' +
      'like Run Selection. Multi-line code is fine. Returns the captured output (stdout and stderr). Variables persist ' +
      'between calls. Starts the session if it is not running. Fails if Octave is busy. If it stops at a breakpoint or ' +
      'keyboard call, the output is returned with the stop location and Octave stays in the debugger (use octave_debug).',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Octave code to run.' }, timeout_seconds: timeoutProp },
      required: ['code'],
    },
  },
  {
    name: 'octave_run_file',
    description:
      'Run an Octave script file (.m) by absolute path in the base workspace, like Run File in VS Code: from its own folder, ' +
      'with the user\'s editor breakpoints active. Returns the captured output. Same busy/timeout/debugger behaviour as octave_run.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of a .m script.' }, timeout_seconds: timeoutProp },
      required: ['path'],
    },
  },
  {
    name: 'octave_status',
    description:
      'Report the session state (not started, starting, idle, busy, debug), the Octave version, the current folder and, when stopped ' +
      'in the debugger, the call stack. Never starts a session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octave_workspace',
    description:
      'List the variables of the current workspace (or of the selected frame while debugging): name, class, size and a short value ' +
      'preview. Use octave_get_value to see a variable in full. Not echoed in the Command Window.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octave_get_value',
    description:
      'Evaluate an Octave expression (typically a variable name, or something like size(A) or A(2,:)) and return its display text, ' +
      'as the Command Window would show it. Runs as a hidden query, not echoed. The expression MUST be free of side effects: ' +
      'do not use it to assign variables, plot or change state (use octave_run for that).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Side-effect-free expression, e.g. "x" or "mean(data(:,2))".' },
        max_chars: { type: 'integer', description: 'Maximum characters to return (default 4000, max 20000).', minimum: 100, maximum: 20000 },
      },
      required: ['expression'],
    },
  },
  {
    name: 'octave_help',
    description:
      'Look up Octave\'s documentation for a function or command: its usage signatures and the help text, also for the user\'s own ' +
      'functions on the path. Not echoed in the Command Window.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Function or command name, e.g. "zeros" or "strsplit".' } },
      required: ['name'],
    },
  },
  {
    name: 'octave_interrupt',
    description:
      'Interrupt (abort) the command that is currently running, like Ctrl+C. The workspace is kept. Does nothing if Octave is not busy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octave_debug',
    description:
      'Control the debugger while Octave is stopped at a breakpoint: continue (run on), step (next line, stepping over calls), ' +
      'step_in (enter a called function), step_out (finish the current function) or quit (leave the debugger and abort the program). ' +
      'Only valid in the debug state. Returns the new state and the stop location. The VS Code debug view follows along.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['continue', 'step', 'step_in', 'step_out', 'quit'], description: 'Debugger action.' } },
      required: ['action'],
    },
  },
  {
    name: 'octave_breakpoints',
    description:
      'List, add or remove the user\'s editor breakpoints in .m files (they show in the VS Code gutter and apply to every run). ' +
      'add needs file (absolute path) and line (1-based). remove needs file; with line it removes that breakpoint, without line ' +
      'all breakpoints of the file.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'What to do.' },
        file: { type: 'string', description: 'Absolute path of the .m file (add, remove).' },
        line: { type: 'integer', description: '1-based line number (add, remove).', minimum: 1 },
      },
      required: ['action'],
    },
  },
];
