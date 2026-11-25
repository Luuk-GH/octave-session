// Drives the installed Octave extension through the demo scenes. Each scene is recorded by recorder.ps1:
// writing a scene name to DEMO_CTL starts recording into that scene, an empty file pauses it.
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

async function type(term, text, ms = 70) {
  for (const ch of text) { term.sendText(ch, false); await sleep(ms); }
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
  if (!ext) { throw new Error('octave-session is not installed'); }
  const api = await ext.activate();
  await cmd('workbench.action.closeAllEditors');
  await cmd('workbench.action.closePanel');
  await cmd('workbench.view.explorer');
  await cmd('workbench.action.zoomReset');
  await cmd('workbench.action.zoomIn');
  await cmd('workbench.action.zoomIn');
  await sleep(4000);                                  // window placement by the recorder, UI settles

  // 1. Install (open the Extensions view once so its commands are registered before the palette searches them)
  await cmd('workbench.view.extensions');
  await sleep(2000);
  await cmd('workbench.view.explorer');
  await sleep(500);
  await cmd('workbench.action.quickOpen', '>Extensions: Install from VSIX');
  await sleep(1500);
  rec('install_palette');
  await sleep(2500);
  rec('');
  await cmd('workbench.action.closeQuickOpen');
  await cmd('workbench.extensions.search', '@installed octave');
  await sleep(2000);
  await cmd('extension.open', ext.id);
  await sleep(1500);
  if (!vscode.window.tabGroups.activeTabGroup.activeTab) {
    log('extension.open did not open the page; selecting the list item');
    await cmd('workbench.extensions.action.focusExtensionsView').then(undefined, () => undefined);
    await cmd('list.focusFirst'); await cmd('list.select');
  }
  await sleep(2000);
  rec('install_details');
  await sleep(3500);
  rec('');
  await cmd('workbench.action.closeAllEditors');

  // 2. Run file (F5)
  await cmd('workbench.view.explorer');
  const doc = await vscode.workspace.openTextDocument(file('analysis.m'));
  await vscode.window.showTextDocument(doc, { preview: false });
  await api.session.show(true);
  await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(3000);
  rec('runfile');
  await sleep(1200);
  await cmd('octave.runFile');
  await sleep(3500);
  rec('');

  // 3. Run section (Ctrl+Enter)
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const secLine = doc.getText().split(/\r?\n/).findIndex(l => l.startsWith('%% Grades'));
  editor.selection = new vscode.Selection(secLine + 2, 0, secLine + 2, 0);
  await sleep(300);
  rec('section');
  await sleep(1200);
  await cmd('octave.runSection');
  await sleep(3000);
  rec('');

  // 4. Command Window: typing with Tab completion
  const term = vscode.window.terminals.find(t => t.name === 'Octave');
  await cmd('workbench.view.explorer');
  term.show(false);
  await sleep(800);
  rec('terminal');
  await sleep(600);
  await type(term, 'r = score_s');
  await sleep(300);
  term.sendText('\t', false);
  await sleep(900);
  await type(term, '(data);');
  await sleep(300);
  term.sendText('\r', false);
  await sleep(800);
  await type(term, 'r.ra');
  await sleep(300);
  term.sendText('\t', false);
  await sleep(900);
  await sleep(500);
  term.sendText('\r', false);
  await sleep(1500);
  await type(term, 'help score_summary', 60);
  term.sendText('\r', false);
  await sleep(2500);
  rec('');

  // 5. Workspace view
  await cmd('octave.workspace.focus');
  await sleep(1500);
  const items = await api.workspace.getChildren();
  const si = items.findIndex(v => v.name === 's');
  await cmd('list.focusFirst');
  for (let i = 0; i < si; i++) { await cmd('list.focusDown'); }
  rec('workspace');
  await sleep(1500);
  await cmd('list.expand');
  await sleep(3000);
  rec('');

  // 6. Debugging
  const fnUri = file('score_summary.m');
  await vscode.window.showTextDocument(fnUri, { preview: false });
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(fnUri, new vscode.Position(3, 0)))]);
  await sleep(1000);
  await cmd('workbench.view.debug');
  await sleep(800);
  rec('debug');
  await sleep(800);
  const stopped = new Promise(res => {
    const d = vscode.debug.onDidChangeActiveStackItem(() => { d.dispose(); res(); });
  });
  await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0],
    { type: 'octave', request: 'launch', name: 'Octave: Run File', program: file('analysis.m').fsPath });
  await Promise.race([stopped, sleep(15000)]);
  await sleep(2500);
  await cmd('workbench.action.debug.stepOver');
  await sleep(1800);
  await cmd('workbench.action.debug.stepOver');
  await sleep(2200);
  await cmd('workbench.action.debug.continue');
  await sleep(2000);
  rec('');
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await vscode.debug.stopDebugging();
  await sleep(1000);

  // 7. edit / open from the Command Window
  await cmd('workbench.view.explorer');
  await cmd('workbench.action.closeAllEditors');
  term.show(false);
  await sleep(1000);
  rec('edit');
  await sleep(600);
  await type(term, 'edit normalize_scores');
  await sleep(300);
  term.sendText('\r', false);
  await sleep(3000);
  rec('');

  // 8. MCP server for AI agents
  await cmd('workbench.action.closeAllEditors');
  await cmd('workbench.action.openSettings', 'octave.mcp');
  await sleep(2500);
  rec('mcp_settings');
  await sleep(3000);
  rec('');
  await cmd('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(800);
  void cmd('octave.mcp.setup');
  await sleep(2000);
  rec('mcp_setup');
  await sleep(3500);
  rec('');
  await cmd('workbench.action.closeQuickOpen');

  // 9. Overview still for the README: a clean run with the Workspace view open
  await cmd('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(doc, { preview: false });
  term.show(true);
  await api.session.execute('clear all');
  term.sendText('\x0c', false);                      // Ctrl+L clears the Command Window
  await sleep(500);
  await cmd('octave.runFile');
  await sleep(1500);
  await cmd('octave.workspace.focus');
  await sleep(1500);
  const vars = await api.workspace.getChildren();
  await cmd('list.focusFirst');
  for (let i = 0; i < vars.findIndex(v => v.name === 's'); i++) { await cmd('list.focusDown'); }
  await cmd('list.expand');
  await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(1500);
  rec('overview');
  await sleep(1500);
  rec('');
}
