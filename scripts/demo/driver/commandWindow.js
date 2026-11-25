// Drives the installed extension's HTML Command Window for screenshots (run with DEMO_SCRIPT=commandWindow.js).
// Each scene is recorded by recorder.ps1; the last frame of a scene is the screenshot.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctl = process.env.DEMO_CTL;
const log = m => fs.appendFileSync(process.env.DEMO_LOG, `${new Date().toISOString()} ${m}\n`);
const rec = name => { fs.writeFileSync(ctl, name); log(`scene ${name || '(pause)'}`); };
const cmd = (id, ...a) => vscode.commands.executeCommand(id, ...a);

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) { return v; } await sleep(100); }
  return undefined;
}

exports.run = async function () {
  try { await scenes(); log('done'); } catch (e) { log(`ERROR ${e.stack || e}`); }
  rec('');
  await sleep(500);
};

async function shot(name, ms = 1600) {
  rec(name);
  await sleep(ms);
  rec('');
  await sleep(300);
}

async function scenes() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = n => vscode.Uri.file(path.join(root, n));
  const ext = await waitFor(() => vscode.extensions.all.find(e => e.packageJSON?.name === 'octave-session'));
  const api = await ext.activate();
  const cw = api.commandWindow;
  const t = action => cw.test(action);
  const snap = () => t({ kind: 'snapshot' });
  const until = async (f, ms = 15000) => waitFor(async () => { const s = await snap(); return s && f(s) ? s : undefined; }, ms);
  const type = text => t({ kind: 'type', text });
  const key = k => t({ kind: 'key', key: k });
  const clearInput = async () => { for (let i = 0; i < 3 && (await snap())?.input; i++) { await key('Escape'); } };
  const submit = async (code, settle = s => s.mode === 'ready') => { await type(code); await key('Enter'); return until(settle); };

  await cmd('workbench.action.closeAllEditors');
  await cmd('workbench.view.explorer');
  await cmd('workbench.action.zoomReset');
  await cmd('workbench.action.zoomIn');
  const doc = await vscode.workspace.openTextDocument(file('analysis.m'));
  await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(3000);                                   // window placement by the recorder
  await cmd('octave.showTerminal');
  await waitFor(() => cw.isReady, 20000);
  await until(s => s.mode === 'ready', 60000);
  await cmd('octave.commandWindow.focus');
  await vscode.window.showTextDocument(doc, { preview: false });
  for (let i = 0; i < 3; i++) { await cmd('workbench.action.decreaseViewHeight'); }   // a shorter editor, a taller panel

  // 1. Overview: Run File output, an error with a clickable frame, a collapsed long output, the usage hint.
  await cmd('octave.runFile');
  await until(s => s.mode === 'ready' && /CBACCBAC/.test(s.text));
  await submit('squares = [(1:60)\' ((1:60).^2)\']', s => s.mode === 'ready' && s.collapsed > 0);
  await submit('z = standardize(data)', s => s.mode === 'ready' && /sd/.test(s.errorText));
  await submit('which score_summary');
  await type('r = linspace(0, ');
  await until(s => /linspace/.test(s.tooltip), 5000);
  await shot('cw_overview');

  // 2. Completion pop-up from the live session (struct fields).
  await clearInput();
  await type('s.');
  await key('Ctrl-Space');
  await until(s => s.completions.length > 0, 5000);
  await shot('cw_completion');

  // 3. Help tooltip on a function name.
  await clearInput();
  await type('parts = strsplit(names{1}, "a")');
  await sleep(300);
  await t({ kind: 'hoverShow', word: 'strsplit' });
  await sleep(1500);
  await shot('cw_hover', 1200);

  // 4. input() waiting for an answer.
  await clearInput();
  await submit('n = input("How many samples? ")', s => s.mode === 'input');
  await type('25');
  await shot('cw_input');
  await key('Enter');
  await until(s => s.mode === 'ready');

  // 5. A long-running command: Stop button.
  await submit('for k = 1:5, printf("step %d of 5\\n", k); pause(1.2); end', s => s.mode === 'busy');
  await sleep(2600);
  await shot('cw_busy', 1000);
  await t({ kind: 'clickStop' });
  await until(s => s.mode === 'ready');

  // 6. Stopped at a breakpoint: K>> prompt, commands run in the function's workspace.
  const fn = file('score_summary.m');
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(fn, new vscode.Position(4, 0)))]);
  await vscode.window.showTextDocument(doc, { preview: false });
  await cmd('octave.runFile');
  await until(s => s.mode === 'debug', 20000);
  await sleep(1500);
  await submit('s', s => s.mode === 'debug' && /mean/.test(s.text));
  await type('dbstep');
  await key('Escape');   // close the completion pop-up, keep the text
  await shot('cw_debug', 1800);
  await clearInput();
  await submit('dbquit');
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
}
