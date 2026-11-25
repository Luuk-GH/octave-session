// Minimal MCP "Streamable HTTP" endpoint on Node's http module: POST /mcp, JSON in, JSON out (no SSE, no sessions).
// Listens on 127.0.0.1 only and checks bearer token, Host and Origin. No VS Code dependency.
import * as crypto from 'crypto';
import * as http from 'http';
import type { HttpReply } from './protocol';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpServerOptions {
  token: string;
  /** First port to try; 0 picks a free port. */
  port: number;
  /** How many following ports to try when a port is taken (default 10). */
  maxExtraPorts?: number;
  /** Handle the raw request text. */
  handle: (text: string) => Promise<HttpReply>;
  log?: (message: string) => void;
}

export interface RunningMcpServer { readonly port: number; close(): Promise<void>; }

/** Equal-length digests make timingSafeEqual usable for any input and hide the token's length. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const a = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b) && !!m;
}

export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const log = opts.log ?? (() => undefined);
  const extra = opts.port === 0 ? 0 : opts.maxExtraPorts ?? 10;
  let boundPort = 0;

  const server = http.createServer((req, res) => {
    void onRequest(req, res).catch(e => {
      log(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) { send(res, 500, { error: 'internal error' }); } else { res.end(); }
    });
  });

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      ...(text !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : { 'Content-Length': '0' }),
      ...headers,
    });
    res.end(text);
  };

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding: a page on another origin can resolve its own name to 127.0.0.1.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) { return send(res, 403, { error: 'forbidden host' }); }
    const origin = req.headers.origin;
    if (origin !== undefined && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) { return send(res, 403, { error: 'forbidden origin' }); }

    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/mcp') { return send(res, 404, { error: 'not found' }); }
    if (req.method !== 'POST') { return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' }); }
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) { return send(res, 415, { error: 'Content-Type must be application/json' }); }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) { return tooLarge(req, res); }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) { return tooLarge(req, res); }
      chunks.push(chunk as Buffer);
    }
    const reply = await opts.handle(Buffer.concat(chunks).toString('utf8'));
    send(res, reply.status, reply.body);
  }

  function tooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
    send(res, 413, { error: 'request body too large (limit 4 MB)' }, { Connection: 'close' });
    res.once('finish', () => req.destroy());
  }

  for (let i = 0; i <= extra; i++) {
    const port = opts.port + i;
    try {
      await listen(server, port);
      boundPort = (server.address() as { port: number }).port;
      if (i > 0) { log(`MCP port ${opts.port} is in use; listening on ${boundPort} instead`); }
      log(`MCP server listening on 127.0.0.1:${boundPort}`);
      return { port: boundPort, close: () => close(server) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i === extra) {
        server.close();
        throw new Error(`MCP server could not listen on 127.0.0.1:${port}: ${(e as Error).message}`);
      }
      log(`MCP port ${port} is in use`);
    }
  }
  throw new Error('unreachable');
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
