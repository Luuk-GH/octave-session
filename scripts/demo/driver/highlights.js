// Drives the installed extension through short feature clips for the README GIFs
// (run with DEMO_SCRIPT=highlights.js DEMO_SCREEN=1 DEMO_W=1440 DEMO_H=900). Each scene becomes one GIF.
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

async function scenes() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = n => vscode.Uri.file(path.join(root, n));
  const ext = await waitFor(() => vscode.extensions.all.find(e => e.packageJSON?.name === 'octave-session'));
  const api = await ext.activate();
  const cw = api.commandWindow;
  const t = action => cw.test(action);
  const snap = () => t({ kind: 'snapshot' });
  const until = async (f, ms = 15000) => waitFor(async () => { const s = await snap(); return s && f(s) ? s : undefined; }, ms);
  const key = k => t({ kind: 'key', key: k });
  const typeSlow = async (text, ms = 55) => { for (const ch of text) { await t({ kind: 'type', text: ch }); await sleep(ms); } };
  const clearInput = async () => { for (let i = 0; i < 3 && (await snap())?.input; i++) { await key('Escape'); } };
  const enter = async (settle = s => s.mode === 'ready') => { await key('Enter'); return until(settle); };
  const showEditor = d => vscode.window.showTextDocument(d, { preview: false });

  // ---- setup (not recorded) ----
  await cmd('workbench.action.closeAllEditors');
  await cmd('workbench.view.explorer');
  await cmd('workbench.action.zoomReset');
  await cmd('workbench.action.zoomIn');
  const doc = await vscode.workspace.openTextDocument(file('analysis.m'));
  await showEditor(doc);
  await sleep(3000);                                       // window placement by the recorder
  await cmd('octave.showTerminal');
  await waitFor(() => cw.isReady, 20000);
  await until(s => s.mode === 'ready', 60000);
  await showEditor(doc);
  await cmd('octave.commandWindow.clear');
  await sleep(800);

  // ---- 1. Run file, section and selection ----
  const ed = await showEditor(doc);
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  rec('run');
  await sleep(1000);
  await cmd('octave.runFile');
  await until(s => /CBACCBAC/.test(s.text) && s.mode === 'ready');
  await sleep(1300);
  const lines = doc.getText().split(/\r?\n/);
  const grades = lines.findIndex(l => l.startsWith('%% Grades'));
  ed.selection = new vscode.Selection(grades + 2, 0, grades + 2, 0);
  await sleep(700);
  await cmd('octave.runSection');
  await until(s => /section "Grades"/.test(s.text) && s.mode === 'ready');
  await sleep(1300);
  const bLine = lines.findIndex(l => l.includes('data >= 80'));
  const col = lines[bLine].indexOf('data >= 80');
  ed.selection = new vscode.Selection(bLine, col, bLine, col + 'data >= 80'.length);
  await sleep(900);
  await cmd('octave.runSelection');                        // F9: the selected expression
  await until(s => /ans =/.test(s.text) && s.mode === 'ready');
  await sleep(1800);
  rec('');

  // ---- 2. Command Window: hint, completion, error links ----
  await cmd('octave.commandWindow.clear');
  await cmd('octave.commandWindow.focus');
  await sleep(500);
  rec('commandwindow');
  await sleep(600);
  await typeSlow('r = linspace(0, ');
  await sleep(1300);                                       // usage hint under the input line
  await typeSlow('1, 5)');
  await enter();
  await sleep(500);
  await typeSlow('s.');
  await key('Ctrl-Space');
  await until(x => x.completions.length > 0, 5000);
  await sleep(1200);
  await key('Enter');                                      // accept the completion
  await sleep(500);
  await enter();
  await sleep(700);
  await typeSlow('z = standardize(data)');
  await enter(x => x.mode === 'ready' && /sd/.test(x.errorText));
  await sleep(1500);
  const sn = await snap();
  const frame = sn.links.findIndex(l => l.func === 'standardize');
  await t({ kind: 'clickLink', index: frame });            // opens standardize.m at the error line
  await sleep(2200);
  rec('');

  // ---- 3. input() and Stop ----
  await showEditor(doc);
  await cmd('workbench.action.closeOtherEditors');
  await cmd('octave.commandWindow.clear');
  await cmd('octave.commandWindow.focus');
  await sleep(400);
  rec('input');
  await sleep(500);
  await typeSlow('n = input("How many samples? ")');
  await enter(x => x.mode === 'input');
  await sleep(900);
  await typeSlow('25', 150);
  await sleep(400);
  await enter();
  await sleep(700);
  await typeSlow('for k = 1:100, printf("step %d\\n", k); pause(0.4); end', 30);
  await key('Enter');
  await until(x => x.mode === 'busy');
  await sleep(2600);
  await t({ kind: 'clickStop' });
  await until(x => x.mode === 'ready');
  await sleep(1500);
  rec('');

  // ---- 4. Debugging ----
  await cmd('octave.commandWindow.clear');
  const fn = file('score_summary.m');
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(fn, new vscode.Position(3, 0)))]);
  await showEditor(doc);
  await sleep(500);
  rec('debug');
  await sleep(800);
  await cmd('octave.runFile');
  await until(x => x.mode === 'debug', 20000);
  await sleep(1800);
  await cmd('workbench.action.debug.stepOver');
  await sleep(1500);
  await cmd('workbench.action.debug.stepOver');
  await sleep(1500);
  await cmd('octave.commandWindow.focus');
  await typeSlow('x(1:3)');
  await enter(x => x.mode === 'debug');
  await sleep(1500);
  await cmd('workbench.action.debug.continue');
  await until(x => x.mode === 'ready');
  await sleep(1500);
  rec('');
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await cmd('workbench.action.closeAllEditors');

  // ---- 5. Workspace view ----
  await showEditor(doc);
  await cmd('octave.commandWindow.clear');
  await sleep(300);
  rec('workspace');
  await sleep(500);
  await cmd('octave.workspace.focus');
  await sleep(1500);
  const vars = await api.workspace.getChildren();
  await cmd('list.focusFirst');
  for (let i = 0; i < vars.findIndex(v => v.name === 's'); i++) { await cmd('list.focusDown'); await sleep(250); }
  await sleep(400);
  await cmd('list.expand');
  await sleep(1500);
  await cmd('octave.commandWindow.focus');
  await typeSlow('s.median = median(data);');
  await enter();
  await sleep(2000);                                       // the view refreshes after the command
  rec('');
}
