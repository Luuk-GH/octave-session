// End-to-end test inside a real Extension Development Host. Run: npm run test:integration
// (Starts a separate VS Code instance with its own user-data-dir, so a running VS Code is not affected.)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { OctaveExtensionApi } from '../src/extension';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; }
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  results.push(line);
  console.log(line);
}
function timeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
}

export async function run(): Promise<void> {
  const resultFile = process.env.OCTAVE_IT_RESULT ?? path.join(os.tmpdir(), 'octave-it-result.txt');
  try {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'octave-session')!;
    const api = (await ext.activate()) as OctaveExtensionApi;
    const testDir = vscode.workspace.workspaceFolders![0].uri.fsPath;
    // Most checks below drive the raw terminal; the HTML Command Window has its own block near the end.
    const cfg = vscode.workspace.getConfiguration('octave');
    await cfg.update('commandWindow.view', 'terminal', vscode.ConfigurationTarget.Global);
    const probeFile = path.join(os.tmpdir(), `octave-it-probe-${process.pid}.txt`).replace(/\\/g, '/');
    const probe = async (expr: string): Promise<string> => {
      fs.rmSync(probeFile, { force: true });
      await api.session.execute(`__f = fopen("${probeFile}", "w"); fprintf(__f, "%s", num2str(${expr})); fclose(__f); clear __f`);
      return fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8') : '<no probe file>';
    };

    const demo = await vscode.window.showTextDocument(vscode.Uri.file(path.join(testDir, 'sections_demo.m')));
    check('language id is octave', demo.document.languageId === 'octave', demo.document.languageId);

    // Run File
    await timeout(Promise.resolve(vscode.commands.executeCommand('octave.runFile')), 60000);
    check('Run File: script ran in base workspace', (await probe('[a b total]')) === '1  2  3', await probe('[a b total]'));

    // Run Section (cursor in the loop section, with b changed beforehand)
    await api.session.execute('clear all; b = 4;');
    demo.selection = new vscode.Selection(10, 0, 10, 0);
    await vscode.commands.executeCommand('octave.runSection');
    check('Run Section: only the cursor section ran', (await probe('total')) === '10', await probe('total'));
    check('Run Section: earlier sections not run', (await probe('exist("a")')) === '0');

    // Run Selection: single line
    await api.session.execute('a = 10;');
    demo.selection = new vscode.Selection(4, 0, 4, 10); // "b = a + 1;"
    await vscode.commands.executeCommand('octave.runSelection');
    check('Run Selection: single line', (await probe('b')) === '11', await probe('b'));

    // Run Selection: no selection -> current line
    demo.selection = new vscode.Selection(1, 3, 1, 3); // "a = 1;"
    await vscode.commands.executeCommand('octave.runSelection');
    check('Run Selection: current line when nothing selected', (await probe('a')) === '1', await probe('a'));

    // Run Selection: multi-line (goes through a temp script)
    await api.session.execute('b = 3;');
    demo.selection = new vscode.Selection(8, 0, 12, 0); // total = 0; for ... end
    await vscode.commands.executeCommand('octave.runSelection');
    check('Run Selection: multi-line block', (await probe('total')) === '6', await probe('total'));

    // Errors don't kill the session
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(testDir, 'error_demo.m')));
    await vscode.commands.executeCommand('octave.runFile');
    check('session survives a script error', (await probe('1+1')) === '2');

    // Interrupt inside a real extension host
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(testDir, 'long_loop.m')));
    const running = Promise.resolve(vscode.commands.executeCommand('octave.runFile'));
    await sleep(2500);
    const t0 = Date.now();
    await vscode.commands.executeCommand('octave.interrupt');
    const r = await timeout(running, 10000);
    check('interrupt stops a running script', r !== 'timeout', `${Date.now() - t0} ms`);
    check('workspace kept after interrupt', Number(await probe('n')) > 0, await probe('n'));

    // ---------------- Debugger ----------------
    const events: { event: string; body?: any }[] = [];
    vscode.debug.registerDebugAdapterTrackerFactory('octave', {
      createDebugAdapterTracker: () => ({ onDidSendMessage: (m: any) => { if (m.type === 'event') { events.push(m); } } }),
    });
    const waitFor = async <T>(fn: () => T | undefined | false, ms = 20000): Promise<T | undefined> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = fn(); if (v) { return v; } await sleep(100); }
      return undefined;
    };
    const waitForAsync = async <T>(fn: () => Promise<T | undefined>, ms = 20000): Promise<T | undefined> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await fn(); if (v) { return v; } await sleep(200); }
      return undefined;
    };
    const stoppedAfter = (n: number) => waitFor(() => events.slice(n).find(e => e.event === 'stopped'));
    const demoUri = vscode.Uri.file(path.join(testDir, 'debug_demo.m'));
    const helperUri = vscode.Uri.file(path.join(testDir, 'debug_helper.m'));
    const bp = (uri: vscode.Uri, line: number) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)));
    await api.session.execute('clear all');
    vscode.debug.addBreakpoints([bp(demoUri, 3), bp(helperUri, 4)]);
    await sleep(1000);

    // Run File stops at a breakpoint and a debug session attaches by itself
    await vscode.window.showTextDocument(demoUri);
    let n = events.length;
    void vscode.commands.executeCommand('octave.runFile');
    let ev = await stoppedAfter(n);
    const ds = await waitFor(() => vscode.debug.activeDebugSession?.type === 'octave' && vscode.debug.activeDebugSession);
    check('debugger: Run File stops at a breakpoint and attaches', !!ev && !!ds, JSON.stringify(ev));
    check('debugger: stop reason is breakpoint', ev?.body?.reason === 'breakpoint', ev?.body?.reason);
    if (ds) {
      let st = await ds.customRequest('stackTrace', { threadId: 1 });
      check('debugger: top frame is debug_demo line 3', st.stackFrames[0]?.name === 'debug_demo' && st.stackFrames[0]?.line === 3
        && /debug_demo\.m$/.test(st.stackFrames[0]?.source?.path ?? ''), JSON.stringify(st.stackFrames[0]));
      check('debugger: helper frames are hidden', !st.stackFrames.some((f: any) => f.name.startsWith('__vsc_')), st.stackFrames.map((f: any) => f.name).join(','));

      n = events.length;
      await ds.customRequest('next', { threadId: 1 });
      ev = await stoppedAfter(n);
      st = await ds.customRequest('stackTrace', { threadId: 1 });
      check('debugger: step over', ev?.body?.reason === 'step' && st.stackFrames[0]?.line === 4, `${ev?.body?.reason} line ${st.stackFrames[0]?.line}`);

      n = events.length;
      await ds.customRequest('continue', { threadId: 1 });
      ev = await stoppedAfter(n);
      st = await ds.customRequest('stackTrace', { threadId: 1 });
      const [top, caller] = st.stackFrames;
      check('debugger: continue stops in the function', top?.name === 'debug_helper' && top?.line === 4 && caller?.name === 'debug_demo' && caller?.line === 7,
        st.stackFrames.map((f: any) => `${f.name}:${f.line}`).join(','));

      const vars = async (frameId: number) => {
        const sc = await ds.customRequest('scopes', { frameId });
        return (await ds.customRequest('variables', { variablesReference: sc.scopes[0].variablesReference })).variables as any[];
      };
      const local = await vars(top.id);
      check('debugger: function variables', ['m', 'scale', 'x'].every(v => local.some(x => x.name === v)), local.map(v => `${v.name}=${v.value}`).join(' '));
      const outer = await vars(caller.id);
      const s = outer.find(v => v.name === 's');
      check('debugger: caller frame variables', !!s && outer.some(v => v.name === 'b' && v.value === '[1 2 3;4 5 6]'), outer.map(v => `${v.name}=${v.value}`).join(' '));
      const kids = s ? (await ds.customRequest('variables', { variablesReference: s.variablesReference })).variables as any[] : [];
      check('debugger: struct fields expand', kids.some(k => k.name === 'value' && k.value === '42'), kids.map(k => `${k.name}=${k.value}`).join(' '));
      const local2 = await vars(top.id);  // switch back to the top frame
      check('debugger: switching frames back', local2.some(v => v.name === 'scale'), local2.map(v => v.name).join(','));

      const hover = await ds.customRequest('evaluate', { expression: 'scale', frameId: top.id, context: 'hover' });
      check('debugger: hover', hover.result === '2', JSON.stringify(hover));
      const watch = await ds.customRequest('evaluate', { expression: 'm(2,3)', frameId: top.id, context: 'watch' });
      check('debugger: watch expression', watch.result === '6', JSON.stringify(watch));
      const repl = await ds.customRequest('evaluate', { expression: 'scale * 3', frameId: top.id, context: 'repl' });
      check('debugger: debug console evaluates in the frame', /ans = 6/.test(repl.result), JSON.stringify(repl));
      const sc = await ds.customRequest('scopes', { frameId: top.id });
      await ds.customRequest('variables', { variablesReference: sc.scopes[0].variablesReference });
      const set = await ds.customRequest('setVariable', { variablesReference: sc.scopes[0].variablesReference, name: 'scale', value: '5' });
      check('debugger: set variable', set.value === '5', JSON.stringify(set));

      const ended = new Promise<void>(res => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); res(); }); });
      await ds.customRequest('continue', { threadId: 1 });
      check('debugger: session ends when the program finishes', (await timeout(ended, 15000)) !== 'timeout');
      check('debugger: changed variable was used', (await probe('total')) === '105', await probe('total'));
    }

    // Launch configuration (F5 from Run and Debug), then Stop
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter(b => (b as vscode.SourceBreakpoint).location?.uri.fsPath === demoUri.fsPath));
    await sleep(500);
    n = events.length;
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0],
      { type: 'octave', request: 'launch', name: 'it', program: demoUri.fsPath });
    ev = await stoppedAfter(n);
    const ds2 = vscode.debug.activeDebugSession;
    const st2 = ds2 ? await ds2.customRequest('stackTrace', { threadId: 1 }) : undefined;
    check('debugger: launch stops in the function breakpoint', started && st2?.stackFrames[0]?.name === 'debug_helper', JSON.stringify(st2?.stackFrames[0]));
    if (ds2) {
      const ended = new Promise<void>(res => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); res(); }); });
      await vscode.debug.stopDebugging(ds2);
      await timeout(ended, 10000);
      await waitFor(() => api.session.state === 'idle', 5000);
      check('debugger: Stop quits debugging (dbquit)', api.session.state === 'idle', api.session.state);    }

    // Stepping past the last line ends the run instead of stopping in the Run File helper
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([bp(demoUri, 12)]);
    await sleep(500);
    await vscode.window.showTextDocument(demoUri);
    n = events.length;
    void vscode.commands.executeCommand('octave.runFile');
    await stoppedAfter(n);
    const ds3 = await waitFor(() => vscode.debug.activeDebugSession?.type === 'octave' && vscode.debug.activeDebugSession);
    if (ds3) {
      const ended = new Promise<void>(res => { const d = vscode.debug.onDidTerminateDebugSession(() => { d.dispose(); res(); }); });
      for (let i = 0; i < 3 && vscode.debug.activeDebugSession === ds3; i++) {
        n = events.length;
        try { await ds3.customRequest('next', { threadId: 1 }); } catch { break; }  // session already gone
        const e = await waitFor(() => events.slice(n).find(x => x.event === 'stopped' || x.event === 'terminated'), 5000);
        if (e?.event === 'terminated') { break; }
      }
      const done = await timeout(ended, 10000);
      check('debugger: stepping off the end finishes the run', done !== 'timeout' && api.session.state === 'idle',
        `${done} ${api.session.state}; stopped in: ${events.slice(n).filter(e => e.event === 'stopped').length}`);
    } else {
      check('debugger: stepping off the end finishes the run', false, 'no debug session');
    }

    // Without breakpoints Run File just runs
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await sleep(500);
    n = events.length;
    await vscode.window.showTextDocument(demoUri);
    await timeout(Promise.resolve(vscode.commands.executeCommand('octave.runFile')), 30000);
    check('debugger: no stop without breakpoints', !events.slice(n).some(e => e.event === 'stopped') && (await probe('total')) === '42', await probe('total'));

    // An edited and saved file runs its new content right away
    const staleUri = vscode.Uri.file(path.join(testDir, 'it_stale_tmp.m'));
    fs.writeFileSync(staleUri.fsPath, 'stale_v = 1;\n');
    const staleDoc = await vscode.window.showTextDocument(staleUri);
    await vscode.commands.executeCommand('octave.runFile');
    await staleDoc.edit(e => e.replace(new vscode.Range(0, 0, 1, 0), 'stale_v = 2;\n'));
    await vscode.commands.executeCommand('octave.runFile');
    check('edited file runs its new content immediately', (await probe('stale_v')) === '2', await probe('stale_v'));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.rmSync(staleUri.fsPath, { force: true });

    // ---------------- Language features ----------------
    const secUri = vscode.Uri.file(path.join(testDir, 'sections_demo.m'));
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', secUri);
    check('outline: %% sections', JSON.stringify(syms?.map(s => s.name)) === '["Second section","Third section: a loop","Plot"]',
      JSON.stringify(syms?.map(s => s.name)));
    const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', secUri);
    const has = (s: number, e: number) => folds?.some(f => f.start === s && f.end === e);
    check('folding: for loop and sections', !!has(9, 10) && !!has(3, 5) && !!has(7, 12), JSON.stringify(folds?.map(f => [f.start, f.end])));
    const helperSyms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', helperUri);
    check('outline: functions with signatures', helperSyms?.length === 2 && helperSyms[0].name === 'debug_helper'
      && helperSyms[0].detail === 'out = debug_helper(x, m)' && helperSyms[1].name === 'inner',
      JSON.stringify(helperSyms?.map(s => [s.name, s.detail])));

    // ---------------- Completion and signature help ----------------
    const compUri = vscode.Uri.file(path.join(testDir, 'it_complete_tmp.m'));
    const compLines = [
      'x = linsp',                       // 0
      'v = my_test_',                    // 1
      'y = my_test_struct.al',           // 2
      'z = zeros(3, ',                   // 3
      'w = local_fn(1, ',                // 4
      'q = debug_helper(',               // 5
      'u = loc',                         // 6
      "disp('linsp",                     // 7  inside a string
      'function r = local_fn(a, b)',     // 8
      '  r = a + b;',                    // 9
      'end',                             // 10
    ];
    fs.writeFileSync(compUri.fsPath, compLines.join('\n') + '\n');
    await vscode.window.showTextDocument(compUri);
    await api.session.execute('my_test_var = 1; my_test_struct.alpha = 2;');
    const complete = async (line: number) => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
        compUri, new vscode.Position(line, compLines[line].length));
      return list?.items ?? [];
    };
    const find = (items: vscode.CompletionItem[], label: string) => items.find(i => (typeof i.label === 'string' ? i.label : i.label.label) === label);
    let items = await complete(0);
    check('completion: Octave functions', find(items, 'linspace')?.kind === vscode.CompletionItemKind.Function, `${items.length} items`);
    items = await complete(1);
    check('completion: workspace variables', find(items, 'my_test_var')?.kind === vscode.CompletionItemKind.Variable
      && !!find(items, 'my_test_struct'), items.map(i => i.label).join(','));
    items = await complete(2);
    check('completion: struct fields', find(items, 'alpha')?.kind === vscode.CompletionItemKind.Field, items.map(i => i.label).join(','));
    items = await complete(6);
    check('completion: functions in this file', find(items, 'local_fn')?.detail === 'r = local_fn(a, b)', JSON.stringify(find(items, 'local_fn')?.detail));
    items = await complete(7);
    check('completion: nothing from Octave inside strings', !find(items, 'linspace') || find(items, 'linspace')?.kind === vscode.CompletionItemKind.Text);

    const sigAt = async (line: number) => vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider',
      compUri, new vscode.Position(line, compLines[line].length), compLines[line].endsWith(', ') ? ',' : '(');
    let sh = await sigAt(3);
    const shLabel = (h?: vscode.SignatureHelp) => h?.signatures[h.activeSignature]?.label;
    check('signature help: Octave function (zeros)', /zeros \(m, n/.test(shLabel(sh) ?? '') && sh?.activeParameter === 1,
      `${shLabel(sh)} param ${sh?.activeParameter} of ${sh?.signatures.length} forms`);
    sh = await sigAt(4);
    check('signature help: function in this file', shLabel(sh) === 'r = local_fn(a, b)' && sh?.activeParameter === 1, `${shLabel(sh)} ${sh?.activeParameter}`);
    sh = await sigAt(5);
    check('signature help: function file on the path', shLabel(sh) === 'out = debug_helper(x, m)' && sh?.activeParameter === 0, `${shLabel(sh)} ${sh?.activeParameter}`);

    // While a script runs, completion falls back to the cached list
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(testDir, 'long_loop.m')));
    const busyRun = Promise.resolve(vscode.commands.executeCommand('octave.runFile'));
    await waitFor(() => api.session.state === 'busy', 5000);
    const t1 = Date.now();
    items = await complete(0);
    check('completion while Octave is busy: cached functions, no wait', !!find(items, 'linspace') && Date.now() - t1 < 1000,
      `${Date.now() - t1} ms, ${items.length} items, state ${api.session.state}`);
    await vscode.commands.executeCommand('octave.interrupt');
    await timeout(busyRun, 10000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(compUri.fsPath, { force: true });

    // ---------------- Command Window Tab completion ----------------
    await api.session.execute('zz_tabtest_value = 7; zz_s.alpha_field = 3; zz_other = 1;');
    const octTerm = vscode.window.terminals.find(t => t.name === 'Octave');
    if (octTerm) {
      octTerm.sendText('zz_r1 = zz_tabt\t', false);   // unique variable
      await sleep(1000);
      octTerm.sendText(' + 1;\r', false);
      await sleep(1000);
      check('terminal Tab: completes a variable', (await probe('zz_r1')) === '8', await probe('zz_r1'));
      octTerm.sendText('zz_r2 = zz_s.alp\t', false);  // struct field
      await sleep(1000);
      octTerm.sendText(' * 2;\r', false);
      await sleep(1000);
      check('terminal Tab: completes a struct field', (await probe('zz_r2')) === '6', await probe('zz_r2'));
      octTerm.sendText('zz_r3 = zz_\t', false);       // several matches: nothing inserted, list shown
      await sleep(1000);
      octTerm.sendText('other;\r', false);
      await sleep(1000);
      check('terminal Tab: ambiguous prefix inserts nothing', (await probe('zz_r3')) === '1', await probe('zz_r3'));

      octTerm.show();
      octTerm.sendText('\x0c', false);                // Ctrl+L: clear the screen for the screenshot
      await sleep(300);
      octTerm.sendText('zz_r4 = linspa\t', false);    // function on the path
      await sleep(1000);
      octTerm.sendText('(0, 1, 3);\r', false);
      await sleep(1000);
      check('terminal Tab: completes a function', (await probe('numel(zz_r4)')) === '3', await probe('numel(zz_r4)'));
      octTerm.sendText('zz_\t', false);               // list of candidates
      await sleep(1000);
      check('terminal Tab: lists candidates', /zz_other\s+zz_r1/.test(api.session.terminalText()));
      octTerm.sendText('\x15', false);                // Ctrl+U: clear the input line
      octTerm.sendText('z = zeros(3, \t', false);     // usage of an Octave function
      await sleep(1500);
      check('terminal Tab in a call: Octave usage', api.session.terminalText().includes('x = zeros (m, n, ...)'),
        JSON.stringify(api.session.terminalText().slice(-400)));
      octTerm.sendText('\x15', false);
      octTerm.sendText('debug_helper(\t', false);     // usage of your own function
      await sleep(1500);
      check('terminal Tab in a call: own function usage', api.session.terminalText().includes('out = debug_helper(x, m)'),
        JSON.stringify(api.session.terminalText().slice(-300)));
      octTerm.sendText('\x15', false);
      const sCount = (await api.session.completeNames('s'))?.length ?? 0;
      octTerm.sendText('s\t', false);                 // many candidates: asks first
      await sleep(1500);
      const asked = api.session.terminalText().includes(`Display all ${sCount} possibilities? (y or n)`);
      check('terminal Tab: asks before listing many candidates', sCount <= 100 || asked, `${sCount} candidates`);
      octTerm.sendText('n', false);
      await sleep(300);
      octTerm.sendText('\x15', false);
      await sleep(500);
      const shot = process.env.OCTAVE_IT_SHOT;
      if (shot) {
        try {
          require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(testDir, '..', 'scripts', 'capture-window.ps1'), '-Title', 'Extension Development Host', '-Out', shot], { windowsHide: true });
        } catch (e) { console.log('screenshot failed', e); }
      }
    } else {
      check('terminal Tab completion', false, 'no Octave terminal');
    }

    // ---------------- edit / open ----------------
    {
      const active = () => vscode.window.activeTextEditor?.document;
      const opened = async (cmd: string, test: (d: vscode.TextDocument) => boolean) => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await api.session.execute(cmd);
        return waitFor(() => { const d = active(); return d && test(d) ? d : undefined; }, 10000);
      };
      const base = (d?: vscode.TextDocument) => d ? path.basename(d.uri.fsPath).toLowerCase() : '';
      let d = await opened('edit debug_helper', x => base(x) === 'debug_helper.m');
      check('edit NAME opens the function file', !!d, base(active()));
      d = await opened('open debug_demo', x => base(x) === 'debug_demo.m');
      check('open NAME (no .m) opens the script in the editor', !!d, base(active()));
      d = await opened('open("sections_demo.m")', x => base(x) === 'sections_demo.m');
      check('open FILE.m opens it in the editor', !!d, base(active()));
      d = await opened('edit strsplit', x => base(x) === 'strsplit.m');
      check('edit opens Octave library functions', !!d, base(active()));
      const newFile = path.join(testDir, 'zz_it_new_file.m');
      fs.rmSync(newFile, { force: true });
      d = await opened('edit zz_it_new_file', x => base(x) === 'zz_it_new_file.m');
      check('edit NEWNAME creates NAME.m in the current folder and opens it', !!d && fs.existsSync(newFile));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(newFile, { force: true });
      d = await opened('edit', x => x.isUntitled && x.languageId === 'octave');
      check('edit without arguments opens an untitled Octave file', !!d, active()?.uri.toString());
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.session.execute('edit zeros');
      await sleep(500);
      check('edit of a built-in reports an error', /built-in or compiled function/.test(api.session.terminalText())
        && !active(), JSON.stringify(api.session.terminalText().slice(-200)));
      const mat = path.join(os.tmpdir(), `octave-it-${process.pid}.mat`).replace(/\\/g, '/');
      await api.session.execute(`zz_mat_value = 123; save("${mat}", "zz_mat_value"); clear zz_mat_value; open("${mat}")`);
      check('open FILE.mat still loads it (Octave\'s own open)', (await probe('zz_mat_value')) === '123', await probe('zz_mat_value'));
      await api.session.execute('clear zz_mat_value');
      fs.rmSync(mat, { force: true });
      check('no record characters reach the Command Window', !/[\x1d\x1e\x1f]/.test(api.session.terminalText()));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }

    // ---------------- Workspace view ----------------
    {
      await vscode.commands.executeCommand('octave.workspace.focus');
      await api.session.execute('clear all; ws_num = 42; ws_mat = magic(3); ws_s.alpha = 1; ws_s.beta = "hi"; ws_c = {1, "two"};');
      const roots = await waitForAsync(async () => {
        const r = await api.workspace.getChildren();
        return r.some((v: any) => v.name === 'ws_c') ? r : undefined;
      }, 10000) as any[] | undefined;
      const byName = (n: string) => roots?.find(v => v.name === n);
      check('workspace view: lists variables', !!roots && ['ws_num', 'ws_mat', 'ws_s', 'ws_c'].every(n => byName(n)),
        JSON.stringify(roots?.map(v => v.name)));
      check('workspace view: value, size and class', byName('ws_num')?.value === '42' && byName('ws_num')?.size === '1x1'
        && byName('ws_num')?.cls === 'double' && byName('ws_mat')?.value === '[8 1 6;3 5 7;4 9 2]', JSON.stringify(byName('ws_mat')));
      const kids = byName('ws_s') ? await api.workspace.getChildren(byName('ws_s')) : [];
      check('workspace view: struct fields expand', kids.map((k: any) => `${k.name}=${k.value}`).join(',') === 'alpha=1,beta="hi"',
        JSON.stringify(kids));
      if (process.env.OCTAVE_IT_SHOT_WS) {
        await sleep(800);
        try {
          require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(testDir, '..', 'scripts', 'capture-window.ps1'), '-Title', 'Extension Development Host', '-Out', process.env.OCTAVE_IT_SHOT_WS], { windowsHide: true });
        } catch (e) { console.log('screenshot failed', e); }
      }
      await vscode.commands.executeCommand('octave.workspace.delete', byName('ws_num'));
      const after = await waitForAsync(async () => {
        const r = await api.workspace.getChildren();
        return r.length > 0 && !r.some((v: any) => v.name === 'ws_num') ? r : undefined;
      }, 10000);
      check('workspace view: Delete clears the variable and refreshes', !!after && (await probe('exist("ws_num")')) === '0');
      await api.session.execute('clear ws_mat ws_s ws_c');
    }

    // ---------------- MCP server ----------------
    const mcpCfg = vscode.workspace.getConfiguration('octave.mcp');
    const mcpWas = mcpCfg.inspect<boolean>('enabled')?.globalValue;
    check('mcp: off by default', api.mcp.port === undefined && mcpCfg.get('enabled') === false);
    try {
      await mcpCfg.update('enabled', true, vscode.ConfigurationTarget.Global);
      const up = await waitFor(() => !!api.mcp.port && !!api.mcp.token, 10000);
      check('mcp: server starts when the setting is enabled', !!up, `port ${api.mcp.port}`);
      if (up) {
        const url = `http://127.0.0.1:${api.mcp.port}/mcp`;
        let rid = 0;
        const rpc = async (method: string, params?: unknown): Promise<any> => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.mcp.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
          });
          return res.json();
        };
        const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
          const r = (await rpc('tools/call', { name, arguments: args })).result;
          return { text: r?.content?.[0]?.text ?? JSON.stringify(r), isError: !!r?.isError };
        };
        const noAuth = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        check('mcp: request without token is rejected', noAuth.status === 401, String(noAuth.status));

        const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'it', version: '1' } });
        check('mcp: initialize', init.result?.protocolVersion === '2025-03-26' && init.result?.serverInfo?.name === 'octave-session'
          && !!init.result?.capabilities?.tools, JSON.stringify(init.result).slice(0, 200));
        const tools = (await rpc('tools/list')).result?.tools?.map((t: any) => t.name) ?? [];
        check('mcp: tools/list has all 9 tools', tools.length === 9 && ['octave_run', 'octave_run_file', 'octave_status', 'octave_workspace',
          'octave_get_value', 'octave_help', 'octave_interrupt', 'octave_debug', 'octave_breakpoints'].every(t => tools.includes(t)), tools.join(','));

        await tool('octave_run', { code: 'clear all' });
        let t = await tool('octave_run', { code: 'x_mcp = 6*7' });
        check('mcp: octave_run returns the output', !t.isError && /x_mcp = 42/.test(t.text), JSON.stringify(t));
        check('mcp: the run is echoed in the Command Window', api.session.terminalText().includes('x_mcp = 6*7'));
        check('mcp: variable lives in the shared session', (await probe('x_mcp')) === '42', await probe('x_mcp'));
        t = await tool('octave_run', { code: 'for i = 1:2\n  y_mcp(i) = i * 10;\nend\ndisp(y_mcp)' });
        check('mcp: octave_run multi-line code', !t.isError && /10\s+20/.test(t.text), JSON.stringify(t));
        t = await tool('octave_get_value', { expression: 'x_mcp' });
        check('mcp: octave_get_value', !t.isError && /x_mcp = 42/.test(t.text), JSON.stringify(t));
        await tool('octave_run', { code: 'ans = 555;' });
        t = await tool('octave_get_value', { expression: 'x_mcp + 1000 + 0' });
        check('mcp: octave_get_value is not echoed and leaves ans alone',
          /ans = 1042/.test(t.text) && !api.session.terminalText().includes('+ 1000') && (await probe('ans')) === '555', JSON.stringify(t));
        t = await tool('octave_get_value', { expression: 'no_such_variable_mcp' });
        check('mcp: octave_get_value error', t.isError && /no_such_variable_mcp/.test(t.text), JSON.stringify(t));
        t = await tool('octave_workspace');
        check('mcp: octave_workspace lists variables', !t.isError && /x_mcp \| double \| 1x1 \| 42/.test(t.text) && /y_mcp/.test(t.text), t.text);
        t = await tool('octave_status');
        check('mcp: octave_status idle', !t.isError && /State: idle/.test(t.text) && /Octave version: \d/.test(t.text) && /Current folder: /.test(t.text), t.text);
        t = await tool('octave_help', { name: 'zeros' });
        check('mcp: octave_help', !t.isError && /zeros \(/.test(t.text), t.text.slice(0, 200));
        t = await tool('octave_run', { code: 'error("mcp_test_failure")' });
        check('mcp: octave_run returns the error text', t.isError && /mcp_test_failure/.test(t.text), JSON.stringify(t));
        t = await tool('octave_run', { code: 'if true' });
        check('mcp: incomplete code is an error, not a stuck session', t.isError && api.session.state === 'idle', `${api.session.state} ${JSON.stringify(t)}`);
        t = await tool('octave_run_file', { path: path.join(testDir, 'nonexistent.m') });
        check('mcp: octave_run_file rejects a missing file', t.isError && /not found/i.test(t.text), t.text);
        t = await tool('octave_run_file', { path: path.join(testDir, 'README.txt') });
        check('mcp: octave_run_file rejects non-.m files', t.isError, t.text);
        t = await tool('octave_run', { code: 'x_mcp = ' });
        check('mcp: syntax error reported', t.isError && api.session.state === 'idle', JSON.stringify(t));

        // busy / timeout / interrupt
        t = await tool('octave_run', { code: 'pause(3)', timeout_seconds: 1 });
        check('mcp: timeout returns a still-running note', !t.isError && /Still running/.test(t.text) && api.session.state === 'busy', `${api.session.state} ${JSON.stringify(t)}`);
        const busyRun = await tool('octave_run', { code: 'disp(1)' });
        check('mcp: second run while busy is refused', busyRun.isError && /busy/i.test(busyRun.text), busyRun.text);
        t = await tool('octave_status');
        check('mcp: octave_status busy', /State: busy/.test(t.text), t.text);
        t = await tool('octave_interrupt');
        const idle = await waitFor(() => api.session.state === 'idle', 8000);
        const st = await tool('octave_status');
        check('mcp: octave_interrupt returns Octave to idle', !!idle && /State: idle/.test(st.text), `${t.text} / ${st.text}`);
        check('mcp: workspace survives the interrupt', (await probe('x_mcp')) === '42');

        // debugger
        const dd = path.join(testDir, 'debug_demo.m');
        t = await tool('octave_debug', { action: 'step' });
        check('mcp: octave_debug outside the debugger is an error', t.isError, t.text);
        t = await tool('octave_breakpoints', { action: 'add', file: dd, line: 3 });
        check('mcp: octave_breakpoints add', !t.isError && vscode.debug.breakpoints.some(b => (b as vscode.SourceBreakpoint).location?.uri.fsPath === dd
          && (b as vscode.SourceBreakpoint).location.range.start.line === 2), t.text);
        t = await tool('octave_breakpoints', { action: 'list' });
        check('mcp: octave_breakpoints list', /debug_demo\.m:3/.test(t.text), t.text);
        t = await tool('octave_run_file', { path: dd, timeout_seconds: 30 });
        check('mcp: octave_run_file stops at the breakpoint', !t.isError && /Stopped in the debugger at .*debug_demo\.m:3/.test(t.text) && api.session.state === 'debug', `${api.session.state} ${JSON.stringify(t)}`);
        t = await tool('octave_status');
        check('mcp: octave_status in the debugger shows the stack', /State: debug/.test(t.text) && /debug_demo.*debug_demo\.m:3/.test(t.text), t.text);
        t = await tool('octave_workspace');
        check('mcp: octave_workspace in the debugger', /\ba \|/.test(t.text) && !/\bb \|/.test(t.text), t.text);
        t = await tool('octave_debug', { action: 'step' });
        check('mcp: octave_debug step', !t.isError && /debug_demo\.m:4/.test(t.text) && api.session.state === 'debug', t.text);
        t = await tool('octave_workspace');
        check('mcp: step made the next variable visible', /\bb \|/.test(t.text), t.text);
        t = await tool('octave_debug', { action: 'quit' });
        const quitIdle = await waitFor(() => api.session.state === 'idle', 8000);
        check('mcp: octave_debug quit', !t.isError && !!quitIdle, `${api.session.state} ${t.text}`);
        await waitFor(() => !vscode.debug.activeDebugSession, 8000);
        t = await tool('octave_breakpoints', { action: 'remove', file: dd, line: 3 });
        check('mcp: octave_breakpoints remove', !t.isError && !vscode.debug.breakpoints.some(b => (b as vscode.SourceBreakpoint).location?.uri.fsPath === dd), t.text);
        t = await tool('octave_run_file', { path: dd, timeout_seconds: 30 });
        check('mcp: octave_run_file without breakpoints just runs', !t.isError && /a = 7/.test(t.text) && api.session.state === 'idle', JSON.stringify(t));
      }
    } finally {
      await mcpCfg.update('enabled', mcpWas, vscode.ConfigurationTarget.Global);
    }
    check('mcp: server stops when the setting is restored', !!(await waitFor(() => api.mcp.port === undefined, 5000)), `port ${api.mcp.port}`);

    // ---------------- HTML Command Window (webview) ----------------
    {
      const cw = api.commandWindow;
      await cfg.update('commandWindow.view', 'webview', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('octave.showTerminal');
      const cwReady = await waitFor(() => cw.isReady, 15000);
      check('command window: webview opens and loads', !!cwReady);
      const snap = async (): Promise<any> => cw.test({ kind: 'snapshot' });
      const type = (text: string) => cw.test({ kind: 'type', text });
      const key = (k: string) => cw.test({ kind: 'key', key: k as any });
      const until = async (f: (s: any) => boolean, ms = 10000): Promise<any> => {
        const end = Date.now() + ms;
        let s: any;
        while (Date.now() < end) { s = await snap(); if (s && f(s)) { return s; } await sleep(150); }
        return s;
      };
      const clearInput = async () => { for (let i = 0; i < 3 && (await snap())?.input; i++) { await key('Escape'); } };
      const submit = async (code: string, settle: (s: any) => boolean = s => s.mode === 'ready') => {
        await type(code);
        await key('Enter');
        return until(settle, 20000);
      };

      let s = await snap();
      check('command window: replays the session so far', /sections_demo/.test(s?.text ?? ''), (s?.text ?? '').slice(0, 200));
      check('command window: ready prompt', s?.mode === 'ready' && s.prompt === '>>', JSON.stringify({ mode: s?.mode, prompt: s?.prompt }));

      await vscode.commands.executeCommand('octave.commandWindow.clear');
      s = await until(x => !x.text.trim());
      check('command window: Clear empties the output', !!s && !s.text.trim(), s?.text);

      // A command typed here runs in the shared session.
      s = await submit('zz_cw = 6*7', x => /zz_cw = 42/.test(x.text) && x.mode === 'ready');
      check('command window: Enter runs the command (echo + output)', /^>> zz_cw = 6\*7$/m.test(s?.text ?? '') && /zz_cw = 42/.test(s?.text ?? ''), s?.text);
      check('command window: same workspace as Run and the debugger', (await probe('zz_cw')) === '42');
      check('command window: input line cleared after Enter', s?.input === '');

      // Errors in red; "called from" frames and file paths are links.
      fs.writeFileSync(path.join(testDir, 'zz_cw_err.m'), 'function zz_cw_err()\n  x = 1;\n  error("cw boom %d", x);\nend\n');
      await submit('clear functions; zz_cw_err()', x => /cw boom/.test(x.text) && x.mode === 'ready');
      s = await snap();
      check('command window: errors are shown in red', /error: cw boom 1/.test(s.errorText), s.errorText);
      const frame = s.links.findIndex((l: any) => l.func === 'zz_cw_err' && l.line === 3);
      check('command window: "called from" frame is a link', frame >= 0, JSON.stringify(s.links));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await cw.test({ kind: 'clickLink', index: frame });
      const opened = await waitFor(() => {
        const e = vscode.window.activeTextEditor;
        return e && /zz_cw_err\.m$/i.test(e.document.fileName) && e.selection.active.line === 2 ? e : undefined;
      }, 8000);
      check('command window: clicking the frame opens the file at the line', !!opened,
        `${vscode.window.activeTextEditor?.document.fileName}:${vscode.window.activeTextEditor?.selection.active.line}`);
      await submit('which zz_cw_err', x => x.mode === 'ready' && /is a function from the file/.test(x.text));
      s = await snap();
      const fileLink = s.links.findIndex((l: any) => l.file && /zz_cw_err\.m$/i.test(l.file));
      check('command window: file paths are links', fileLink >= 0, JSON.stringify(s.links.slice(-3)));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await cw.test({ kind: 'clickLink', index: fileLink });
      check('command window: clicking a path opens it', !!(await waitFor(() => /zz_cw_err\.m$/i.test(vscode.window.activeTextEditor?.document.fileName ?? ''), 8000)));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(testDir, 'zz_cw_err.m'), { force: true });

      // Long output is collapsed once the command finishes.
      s = await submit('disp((1:120)\')', x => /\b120\b/.test(x.text) && x.mode === 'ready');
      s = await until(x => x.collapsed > 0, 3000);
      check('command window: long output is collapsed', s?.collapsed === 1, String(s?.collapsed));
      await cw.test({ kind: 'toggleCollapse', index: 0 });
      s = await snap();
      check('command window: "Show all" expands it', s?.collapsed === 0, String(s?.collapsed));
      s = await submit('disp(1:3)');
      check('command window: short output is not collapsed', s?.collapsed === 0, String(s?.collapsed));

      // Shift+Enter: multi-line input runs as one block.
      await type('zz_s = 0;');
      await key('Shift-Enter');
      await type('for zz_k = 1:4, zz_s = zz_s + zz_k; end');
      s = await snap();
      check('command window: Shift+Enter adds a line', s?.input === 'zz_s = 0;\nfor zz_k = 1:4, zz_s = zz_s + zz_k; end', JSON.stringify(s?.input));
      await key('Enter');
      await until(x => x.mode === 'ready' && x.input === '');
      check('command window: multi-line input runs', (await probe('zz_s')) === '10', await probe('zz_s'));

      // History: Up/Down filtered by the typed prefix.
      await type('zz_c');
      await key('ArrowUp');
      s = await snap();
      check('command window: Up recalls the last command with the typed prefix', s?.input === 'zz_cw = 6*7', JSON.stringify(s?.input));
      await key('ArrowDown');
      s = await snap();
      check('command window: Down returns to the typed text', s?.input === 'zz_c', JSON.stringify(s?.input));
      await clearInput();
      await type('dis');
      await key('ArrowUp');
      s = await snap();
      check('command window: prefix filter skips other commands', s?.input === 'disp(1:3)', JSON.stringify(s?.input));
      await clearInput();

      // Syntax highlighting in the input line.
      await type('for k = 1:3 % comment');
      s = await snap();
      check('command window: input line is syntax-highlighted', (s?.highlighted?.length ?? 0) >= 3, JSON.stringify(s?.highlighted));
      await clearInput();

      // Completion from the live session.
      await api.session.query('zz_completion_var = 1; zz_st.alpha = 1; zz_st.beta = 2;');
      await type('zz_completion_v');
      await key('Ctrl-Space');
      s = await until(x => x.completions.length > 0, 5000);
      check('command window: completion pop-up lists workspace variables', s?.completions?.includes('zz_completion_var'),
        JSON.stringify({ c: s?.completions, input: s?.input, mode: s?.mode, cwMode: cw.inputMode, state: api.session.state,
          direct: await api.session.completeNames('zz_completion_v') }));
      await key('Enter');
      s = await snap();
      check('command window: Enter accepts the completion', s?.input === 'zz_completion_var', JSON.stringify(s?.input));
      await clearInput();
      await type('zz_st.');
      await key('Ctrl-Space');
      s = await until(x => x.completions.length > 0, 5000);
      check('command window: struct fields complete', ['alpha', 'beta'].every(f => s?.completions?.includes(f)), JSON.stringify(s?.completions));
      await clearInput();

      // Help: tooltip text and the function hint while typing a call.
      const hover = await cw.test({ kind: 'hover', word: 'strsplit' });
      check('command window: help tooltip from help/which', /strsplit \(/.test(hover ?? '') && /strsplit\.m/i.test(hover ?? ''), String(hover));
      await type('linspace(');
      s = await until(x => /linspace/.test(x.tooltip), 5000);
      check('command window: usage hint while typing a call', /linspace \(/.test(s?.tooltip ?? ''), s?.tooltip);
      await clearInput();

      // While a command runs: Stop is shown, Enter queues, completion is not asked.
      await type('zz_t = tic; while toc(zz_t) < 30, end');
      await key('Enter');
      s = await until(x => x.mode === 'busy');
      check('command window: busy mode shows Stop', s?.mode === 'busy' && s.stopVisible, JSON.stringify({ mode: s?.mode, stop: s?.stopVisible }));
      await type('zz_compl');
      await key('Ctrl-Space');
      await sleep(800);
      s = await snap();
      check('command window: no completion queries while busy', s?.completions?.length === 0, JSON.stringify(s?.completions));
      await clearInput();
      const ts = Date.now();
      await cw.test({ kind: 'clickStop' });
      s = await until(x => x.mode === 'ready', 10000);
      check('command window: Stop interrupts the command', s?.mode === 'ready' && !s.stopVisible, `${Date.now() - ts} ms`);

      // input(), pause and keyboard switch the input mode.
      s = await submit('zz_in = input("Value? ")', x => x.mode === 'input');
      check('command window: input() switches to input mode', s?.mode === 'input' && /Value\? $/.test(s.text), JSON.stringify(s?.text.slice(-40)));
      s = await submit('5*3', x => x.mode === 'ready');
      check('command window: the answer goes to input()', /Value\? 5\*3/.test(s?.text ?? '') && (await probe('zz_in')) === '15', JSON.stringify(s?.text.slice(-60)));
      s = await submit('pause; zz_p = 7;', x => x.mode === 'input');
      check('command window: pause waits for Enter', s?.mode === 'input');
      await key('Enter');
      await until(x => x.mode === 'ready');
      check('command window: Enter continues after pause', (await probe('zz_p')) === '7');
      s = await submit('keyboard', x => x.mode === 'debug');
      check('command window: keyboard switches to the debugger prompt', s?.mode === 'debug' && s.prompt === 'K>>', JSON.stringify({ mode: s?.mode, prompt: s?.prompt }));
      s = await submit('dbcont', x => x.mode === 'ready');
      check('command window: dbcont returns to >>', s?.mode === 'ready');
      s = await submit('zz_never = input("x? ")', x => x.mode === 'input');
      await cw.test({ kind: 'clickStop' });
      s = await until(x => x.mode === 'ready', 8000);
      check('command window: Stop while waiting for input', s?.mode === 'ready' && (await probe('exist("zz_never")')) === '0');

      // Commands from the editor and the raw terminal show up here too.
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(testDir, 'sections_demo.m')));
      await vscode.commands.executeCommand('octave.runFile');
      s = await until(x => /^>> sections_demo$/m.test(x.text) && x.mode === 'ready');
      check('command window: Run File is echoed here', /^>> sections_demo$/m.test(s?.text ?? ''));
      await vscode.commands.executeCommand('octave.showRawTerminal');
      const raw = await waitFor(() => vscode.window.terminals.find(tt => tt.name === 'Octave'), 8000);
      check('command window: raw terminal view still available', !!raw);
      if (raw) {
        await sleep(500);
        raw.sendText('zz_raw = 5 + 5', true);
        s = await until(x => /zz_raw = 10/.test(x.text));
        check('command window: lines typed in the raw terminal appear here', /^>> zz_raw = 5 \+ 5$/m.test(s?.text ?? '') && /zz_raw = 10/.test(s?.text ?? ''), s?.text.slice(-120));
        raw.dispose();
        await sleep(1000);
        check('command window: closing the raw terminal keeps the session', api.session.state === 'idle' && (await probe('zz_raw')) === '10', api.session.state);
      }
      s = await submit('clc', x => !/zz_raw/.test(x.text));
      check('command window: clc clears the output', !!s && !/zz_raw/.test(s.text), JSON.stringify(s?.text.slice(0, 100)));
      await cfg.update('commandWindow.view', 'terminal', vscode.ConfigurationTarget.Global);
    }

    // Restart gives a fresh workspace
    await vscode.commands.executeCommand('octave.restart');
    check('restart: fresh workspace', (await probe('exist("n")')) === '0');
  } catch (err) {
    check('no exception', false, String((err as Error).stack ?? err));
  } finally {
    results.push(failures ? `${failures} FAILED` : 'ALL PASSED');
    fs.writeFileSync(resultFile, results.join('\n') + '\n', 'utf8');
  }
  if (failures) { throw new Error(`${failures} integration checks failed`); }
}
