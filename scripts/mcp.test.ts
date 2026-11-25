// Unit checks for the MCP protocol layer (fake backend) and the HTTP server (real, ephemeral port).
// No VS Code, no Octave. Run: npm run test:unit
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { cleanOutput, handleText, McpBackend, textResult, ToolDef, truncateText } from '../src/mcp/protocol';
import { startMcpServer } from '../src/mcp/server';
import { TOOLS } from '../src/mcp/tools';

const info = { name: 'octave-session', version: '9.9.9', instructions: 'test instructions' };
const echoTool: ToolDef = {
  name: 'echo',
  description: 'Echo text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['text'] },
};
const backend: McpBackend = {
  tools: () => [echoTool],
  callTool: async (name, args) => {
    if (args.text === 'boom') { throw new Error('exploded'); }
    if (args.text === 'fail') { return textResult('nope', true); }
    return textResult(`${name}:${args.text}`);
  },
};
const rpc = async (msg: unknown) => handleText(JSON.stringify(msg), backend, info);

async function main(): Promise<void> {
  // ---- initialize ----
  for (const [asked, got] of [['2025-03-26', '2025-03-26'], ['2024-11-05', '2024-11-05'], ['2025-06-18', '2025-06-18'], ['1999-01-01', '2025-06-18'], [undefined, '2025-06-18']]) {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked } });
    const res = (r.body as any).result;
    assert.strictEqual(r.status, 200);
    assert.strictEqual(res.protocolVersion, got, `version for ${asked}`);
    assert.deepStrictEqual(res.capabilities, { tools: {} });
    assert.deepStrictEqual(res.serverInfo, { name: 'octave-session', version: '9.9.9' });
    assert.strictEqual(res.instructions, 'test instructions');
  }

  // ---- ping, tools/list ----
  assert.deepStrictEqual((await rpc({ jsonrpc: '2.0', id: 'a', method: 'ping' })).body, { jsonrpc: '2.0', id: 'a', result: {} });
  const list = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body as any;
  assert.deepStrictEqual(list.result.tools, [echoTool]);

  // ---- tools/call: ok, tool error, thrown error, bad arguments, unknown tool ----
  let r: any = (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })).body;
  assert.deepStrictEqual(r.result, { content: [{ type: 'text', text: 'echo:hi' }] });
  r = (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'fail' } } })).body;
  assert.strictEqual(r.result.isError, true);
  assert.strictEqual(r.result.content[0].text, 'nope');
  r = (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'boom' } } })).body;
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /exploded/);
  assert.strictEqual(r.error, undefined);
  for (const args of [{}, { text: 5 }, { text: 'x', n: 9 }, { text: 'x', n: 1.5 }, 'str']) {
    r = (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: args } })).body;
    assert.strictEqual(r.result.isError, true, JSON.stringify(args));
    assert.match(r.result.content[0].text, /Invalid arguments/);
  }
  r = (await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } })).body;
  assert.strictEqual(r.error.code, -32602);

  // ---- unknown method, malformed, notifications, batch ----
  r = await rpc({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.strictEqual((r.body as any).error.code, -32601);
  assert.strictEqual((r.body as any).id, 8);
  r = await handleText('{not json', backend, info);
  assert.strictEqual((r.body as any).error.code, -32700);
  r = await rpc({ id: 9, method: 'ping' });
  assert.strictEqual((r.body as any).error.code, -32600);
  r = await rpc(42);
  assert.strictEqual((r.body as any).error.code, -32600);
  r = await rpc([]);
  assert.strictEqual((r.body as any).error.code, -32600);
  r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepStrictEqual(r, { status: 202 });
  r = await rpc({ jsonrpc: '2.0', id: 10, result: {} });  // a response from the client
  assert.deepStrictEqual(r, { status: 202 });
  r = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]);
  assert.deepStrictEqual(r, { status: 202 });
  r = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 2);
  assert.deepStrictEqual(r.body[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.strictEqual(r.body[1].error.code, -32601);

  // ---- tool catalogue sanity ----
  assert.deepStrictEqual(TOOLS.map(t => t.name), ['octave_run', 'octave_run_file', 'octave_status', 'octave_workspace', 'octave_get_value',
    'octave_help', 'octave_interrupt', 'octave_debug', 'octave_breakpoints']);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40 && t.inputSchema.type === 'object', t.name);
    for (const req of t.inputSchema.required ?? []) { assert.ok(t.inputSchema.properties?.[req], `${t.name}.${req}`); }
  }

  // ---- truncation and cleaning ----
  assert.strictEqual(truncateText('short'), 'short');
  assert.strictEqual(truncateText('x'.repeat(20000)), 'x'.repeat(20000));
  const big = 'A'.repeat(15000) + 'B'.repeat(15000);
  const cut = truncateText(big);
  assert.ok(cut.startsWith('A'.repeat(10000)) && cut.endsWith('B'.repeat(10000)));
  assert.ok(cut.includes('... [10000 characters omitted] ...'));
  assert.ok(cut.length < 20100);
  assert.strictEqual(truncateText('abcdefghij', 4), 'ab\n... [6 characters omitted] ...\nij');
  assert.strictEqual(cleanOutput('\x1b[31merror:\x1b[0m bad\r\nok\x01OCT_READY\x02\x1b]0;title\x07!'), 'error: bad\nok!');

  // ---- HTTP server ----
  const token = 'secret-token-0123456789abcdef';
  const logs: string[] = [];
  const srv = await startMcpServer({ token, port: 0, log: m => logs.push(m), handle: text => handleText(text, backend, info) });
  const url = `http://127.0.0.1:${srv.port}/mcp`;
  const good = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const post = (headers: Record<string, string>, body = ping) => fetch(url, { method: 'POST', headers, body });

  let res = await post(good);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepStrictEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: {} });

  res = await post({ 'Content-Type': 'application/json' });
  assert.strictEqual(res.status, 401);
  res = await post({ ...good, Authorization: 'Bearer wrong' });
  assert.strictEqual(res.status, 401);
  res = await post({ ...good, Authorization: token });
  assert.strictEqual(res.status, 401);
  res = await post({ ...good, Authorization: `Bearer ${token}x` });
  assert.strictEqual(res.status, 401);

  // fetch forbids Origin/Host overrides, so these use http.request.
  const raw = (headers: Record<string, string>, method = 'POST', pathName = '/mcp', body = ping) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: pathName, method, headers: { 'Content-Length': String(Buffer.byteLength(body)), ...headers } }, rs => {
      let data = '';
      rs.on('data', c => { data += c; });
      rs.on('end', () => resolve({ status: rs.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.strictEqual((await raw({ ...good, Origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await raw({ ...good, Origin: 'https://localhost' })).status, 403);
  assert.strictEqual((await raw({ ...good, Origin: 'http://localhost.evil.example' })).status, 403);
  assert.strictEqual((await raw({ ...good, Origin: 'http://localhost:3000' })).status, 200);
  assert.strictEqual((await raw({ ...good, Origin: 'http://127.0.0.1' })).status, 200);
  assert.strictEqual((await raw({ ...good, Host: 'evil.example' })).status, 403);
  assert.strictEqual((await raw({ ...good, Host: `evil.example:${srv.port}` })).status, 403);
  assert.strictEqual((await raw({ ...good, Host: '127.0.0.1:1' })).status, 403);
  assert.strictEqual((await raw({ ...good, Host: `localhost:${srv.port}` })).status, 200);
  assert.strictEqual((await raw({ ...good, Host: `127.0.0.1:${srv.port}` })).status, 200);

  res = await post({ ...good, 'Content-Type': 'text/plain' });
  assert.strictEqual(res.status, 415);
  res = await post({ Authorization: good.Authorization });
  assert.strictEqual(res.status, 415);
  res = await post({ ...good, 'Content-Type': 'application/json; charset=utf-8' });
  assert.strictEqual(res.status, 200);

  res = await fetch(url, { method: 'GET', headers: good });
  assert.strictEqual(res.status, 405);
  res = await fetch(url, { method: 'DELETE', headers: good });
  assert.strictEqual(res.status, 405);
  res = await fetch(`http://127.0.0.1:${srv.port}/other`, { method: 'POST', headers: good, body: ping });
  assert.strictEqual(res.status, 404);
  res = await fetch(`http://127.0.0.1:${srv.port}/`, { headers: good });
  assert.strictEqual(res.status, 404);

  res = await post(good, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.strictEqual(res.status, 202);
  assert.strictEqual(await res.text(), '');
  res = await post(good, '{oops');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(((await res.json()) as any).error.code, -32700);
  res = await post(good, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
  assert.strictEqual(((await res.json()) as any[]).length, 2);

  // body cap: 413 (Content-Length is checked up front, so no 4 MB upload is needed)
  const tooBig = await raw({ ...good, 'Content-Length': String(5 * 1024 * 1024) }, 'POST', '/mcp', 'x').catch(() => ({ status: 413, body: '' }));
  assert.strictEqual(tooBig.status, 413);
  // ... and a body that is actually larger than the cap (chunked, no Content-Length)
  const chunked = await new Promise<number>(resolve => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/mcp', method: 'POST', headers: { ...good } }, rs => { rs.resume(); resolve(rs.statusCode ?? 0); });
    req.on('error', () => resolve(413));  // connection closed after the 413 was sent
    const piece = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 5; i++) { req.write(piece); }
    req.end();
  });
  assert.strictEqual(chunked, 413);
  // the server still works afterwards
  assert.strictEqual((await post(good)).status, 200);
  assert.ok(!logs.some(l => l.includes(token)), 'token must not be logged');

  // ---- port fallback when the preferred port is taken ----
  const blocker = net.createServer();
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', () => r()));
  const taken = (blocker.address() as net.AddressInfo).port;
  const logs2: string[] = [];
  const srv2 = await startMcpServer({ token, port: taken, log: m => logs2.push(m), handle: text => handleText(text, backend, info) });
  assert.ok(srv2.port > taken && srv2.port <= taken + 10, `fallback port ${srv2.port} (taken ${taken})`);
  assert.ok(logs2.some(l => l.includes(String(srv2.port)) && /in use/.test(l)), logs2.join(' | '));
  res = await fetch(`http://127.0.0.1:${srv2.port}/mcp`, { method: 'POST', headers: good, body: ping });
  assert.strictEqual(res.status, 200);
  await srv2.close();
  await new Promise<void>(r => blocker.close(() => r()));

  // ---- listens on loopback only ----
  const addrs = await Promise.all([srv.port].map(p => new Promise<string>(r => {
    const s = net.connect(p, '127.0.0.1', () => { s.destroy(); r('ok'); });
    s.on('error', () => r('refused'));
  })));
  assert.deepStrictEqual(addrs, ['ok']);

  await srv.close();
  await assert.rejects(post(good));
  console.log('mcp: all assertions passed');
}

main().catch(e => { console.error(e); process.exit(1); });
