import * as vscode from 'vscode';
import { OctaveDebugAdapter } from './debugAdapter';
import { SessionManager } from './session';

/**
 * Debugger wiring:
 * - editor breakpoints are mirrored into Octave at all times (not only during a debug session);
 * - when Octave stops in the debugger without a debug session (Run File, F9, a call typed in the
 *   Command Window), a debug session attaches automatically, like MATLAB entering debug mode;
 * - saved .m files are marked stale so Octave re-reads them before the next run.
 */
export function registerDebugger(context: vscode.ExtensionContext, session: SessionManager, log: vscode.LogOutputChannel): void {
  let octaveSessions = 0;
  let attaching = false;
  const known = new Set<string>();   // files that had breakpoints, so removals are sent too

  const syncBreakpoints = () => {
    const byFile = new Map<string, number[]>();
    for (const bp of vscode.debug.breakpoints) {
      if (!(bp instanceof vscode.SourceBreakpoint) || !bp.enabled) { continue; }
      const uri = bp.location.uri;
      if (uri.scheme !== 'file' || !/\.m$/i.test(uri.fsPath)) { continue; }
      const lines = byFile.get(uri.fsPath) ?? [];
      lines.push(bp.location.range.start.line + 1);
      byFile.set(uri.fsPath, lines);
    }
    for (const f of known) { if (!byFile.has(f)) { session.breakpoints.set(f, []); } }
    known.clear();
    for (const [f, lines] of byFile) { session.breakpoints.set(f, lines); known.add(f); }
    session.breakpoints.flush();
  };

  const autoAttach = async () => {
    if (octaveSessions > 0 || attaching) { return; }
    attaching = true;
    try {
      const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0],
        { type: 'octave', request: 'attach', name: 'Octave' });
      if (!ok) { log.warn('could not start the debug session for Octave'); }
    } finally {
      attaching = false;
    }
  };

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('octave', {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new OctaveDebugAdapter(session, log)),
    }),
    vscode.debug.registerDebugConfigurationProvider('octave', {
      provideDebugConfigurations: () => [{ type: 'octave', request: 'launch', name: 'Octave: Run File', program: '${file}' }],
      resolveDebugConfiguration: (_folder, config) => {
        if (!config.type && !config.request && !config.name) {
          // F5 without a launch.json
          if (vscode.window.activeTextEditor?.document.languageId !== 'octave') { return undefined; }
          return withConsole({ type: 'octave', request: 'launch', name: 'Octave: Run File', program: '${file}' });
        }
        if (config.request === 'launch' && !config.program) { config.program = '${file}'; }
        return withConsole(config);
      },
    }),
    vscode.debug.onDidStartDebugSession(s => { if (s.type === 'octave') { octaveSessions++; } }),
    vscode.debug.onDidTerminateDebugSession(s => { if (s.type === 'octave') { octaveSessions = Math.max(0, octaveSessions - 1); } }),
    vscode.debug.onDidChangeBreakpoints(syncBreakpoints),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme === 'file' && /\.m$/i.test(doc.uri.fsPath)) { session.breakpoints.markStale(doc.uri.fsPath); }
    }),
    session.onDidPrompt(e => { if (e.kind === 'debug' && !e.hidden) { void autoAttach(); } }),
  );
  syncBreakpoints();
}

/**
 * With the HTML Command Window, Octave's own window is the place to type commands while paused, so VS Code's
 * Debug Console does not need to take over the panel when debugging starts (unless the configuration says so).
 */
function withConsole(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
  const view = vscode.workspace.getConfiguration('octave').get<string>('commandWindow.view');
  if (view !== 'terminal' && config.internalConsoleOptions === undefined) { config.internalConsoleOptions = 'neverOpen'; }
  return config;
}
