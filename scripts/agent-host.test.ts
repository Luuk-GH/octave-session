// Keeps an Extension Development Host open with the MCP server on, for trying agents (and the agent-toolkit
// skills) against it. Writes {port, token} to OCTAVE_AGENT_INFO and stays up until OCTAVE_AGENT_STOP exists
// (or 30 minutes pass). Run: npm run agent-host
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { OctaveExtensionApi } from '../src/extension';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<void> {
  const info = process.env.OCTAVE_AGENT_INFO!;
  const stop = process.env.OCTAVE_AGENT_STOP!;
  const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'octave-session')!;
  const api = (await ext.activate()) as OctaveExtensionApi;
  await vscode.workspace.getConfiguration('octave.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
  const end = Date.now() + 30000;
  while (!(api.mcp.port && api.mcp.token) && Date.now() < end) { await sleep(200); }
  await api.session.show();
  await vscode.commands.executeCommand('octave.workspace.focus');
  fs.writeFileSync(info, JSON.stringify({ port: api.mcp.port, token: api.mcp.token }));
  const until = Date.now() + 30 * 60 * 1000;
  while (!fs.existsSync(stop) && Date.now() < until) { await sleep(1000); }
}
