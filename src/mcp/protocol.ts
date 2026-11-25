// MCP (Model Context Protocol) message handling, by hand and without any VS Code dependency, so it can be
// unit-tested with a fake backend. Transport (HTTP) lives in server.ts, the Octave tools in index.ts.

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_TEXT_CHARS = 20000;

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** What the protocol layer needs from the application. */
export interface McpBackend {
  tools(): ToolDef[];
  /** Run a tool. Arguments are already validated against the tool's inputSchema. May throw: reported as isError. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo { name: string; version: string; instructions: string; }

export type JsonRpcId = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603;

const err = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: truncateText(text) }], ...(isError ? { isError: true } : {}) };
}

/** Keep the head and the tail of overlong text, with a marker for what was left out. */
export function truncateText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) { return text; }
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} characters omitted] ...\n${tail ? text.slice(-tail) : ''}`;
}

/** Remove terminal control sequences and the session's internal prompt marker bytes; normalise line ends. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')           // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')                      // CSI (colours, cursor)
    .replace(/\x1b[@-Z\\-_]/g, '')                                // other two-byte escapes
    .replace(/\x01OCT_(?:READY|MORE)\x02/g, '')
    .replace(/[\x01\x02]/g, '')
    .replace(/\r\n/g, '\n');
}

/** Minimal JSON Schema check (object properties, required, primitive types, enum, min/max). Returns a message or undefined. */
export function validateArgs(schema: JsonSchema, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) { return 'arguments must be an object'; }
  const a = args as Record<string, unknown>;
  for (const k of schema.required ?? []) {
    if (a[k] === undefined) { return `missing required argument "${k}"`; }
  }
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    const v = a[k];
    if (v === undefined) { continue; }
    if (p.type === 'string' && typeof v !== 'string') { return `argument "${k}" must be a string`; }
    if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) { return `argument "${k}" must be a number`; }
    if (p.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) { return `argument "${k}" must be an integer`; }
    if (p.type === 'boolean' && typeof v !== 'boolean') { return `argument "${k}" must be a boolean`; }
    if (p.enum && !p.enum.includes(v)) { return `argument "${k}" must be one of: ${p.enum.join(', ')}`; }
    if (typeof v === 'number') {
      if (p.minimum !== undefined && v < p.minimum) { return `argument "${k}" must be at least ${p.minimum}`; }
      if (p.maximum !== undefined && v > p.maximum) { return `argument "${k}" must be at most ${p.maximum}`; }
    }
  }
  return undefined;
}

async function handleOne(msg: unknown, backend: McpBackend, info: ServerInfo): Promise<JsonRpcResponse | undefined> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) { return err(null, INVALID_REQUEST, 'Invalid Request'); }
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
  const hasId = m.id !== undefined;
  const idOk = typeof m.id === 'string' || typeof m.id === 'number' || m.id === null;
  if (m.jsonrpc !== '2.0') { return err(hasId && idOk ? m.id as JsonRpcId : null, INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be "2.0"'); }
  if (typeof m.method !== 'string') {
    // A response from the client to a server request: nothing to do.
    if (hasId && (m.result !== undefined || m.error !== undefined)) { return undefined; }
    return err(hasId && idOk ? m.id as JsonRpcId : null, INVALID_REQUEST, 'Invalid Request: "method" is missing');
  }
  if (!hasId) { return undefined; }  // notification (notifications/initialized, notifications/cancelled, ...)
  if (!idOk) { return err(null, INVALID_REQUEST, 'Invalid Request: bad "id"'); }
  const id = m.id as JsonRpcId;
  const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize': {
      const wanted = params.protocolVersion;
      const protocolVersion = typeof wanted === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(wanted)
        ? wanted : SUPPORTED_PROTOCOL_VERSIONS[0];
      return { jsonrpc: '2.0', id, result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: backend.tools() } };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') { return err(id, INVALID_PARAMS, 'tools/call needs a tool "name"'); }
      const tool = backend.tools().find(t => t.name === name);
      if (!tool) { return err(id, INVALID_PARAMS, `Unknown tool: ${name}`); }
      const args = params.arguments === undefined ? {} : params.arguments;
      const problem = validateArgs(tool.inputSchema, args);
      if (problem) { return { jsonrpc: '2.0', id, result: textResult(`Invalid arguments for ${name}: ${problem}`, true) }; }
      try {
        return { jsonrpc: '2.0', id, result: await backend.callTool(name, args as Record<string, unknown>) };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: textResult(`${name} failed: ${(e as Error).message ?? e}`, true) };
      }
    }
    default:
      return err(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}

export interface HttpReply { status: number; body?: unknown; }

/** Handle one parsed HTTP body (a message or a batch): the status and JSON body to answer with. */
export async function handleBody(body: unknown, backend: McpBackend, info: ServerInfo): Promise<HttpReply> {
  if (Array.isArray(body)) {
    if (!body.length) { return { status: 400, body: err(null, INVALID_REQUEST, 'Invalid Request: empty batch') }; }
    const replies = (await Promise.all(body.map(m => handleOne(m, backend, info)))).filter((r): r is JsonRpcResponse => !!r);
    return replies.length ? { status: 200, body: replies } : { status: 202 };
  }
  const reply = await handleOne(body, backend, info);
  if (!reply) { return { status: 202 }; }
  return { status: reply.error && reply.id === null ? 400 : 200, body: reply };
}

/** Handle raw request text: JSON parse errors answer -32700. */
export async function handleText(text: string, backend: McpBackend, info: ServerInfo): Promise<HttpReply> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { status: 400, body: err(null, PARSE_ERROR, 'Parse error') }; }
  try {
    return await handleBody(body, backend, info);
  } catch (e) {
    return { status: 500, body: err(null, INTERNAL_ERROR, (e as Error).message) };
  }
}
