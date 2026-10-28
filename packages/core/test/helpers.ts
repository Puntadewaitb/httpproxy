import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { generateCACertificate } from 'mockttp';
import { WebSocketServer } from 'ws';

export const tmp = () => mkdtempSync(join(tmpdir(), 'proxykit-'));

export interface Target {
  http: http.Server;
  https: https.Server;
  httpPort: number;
  httpsPort: number;
  /** cert yang dipakai server HTTPS target (self-signed) */
  cert: string;
  /** semua request yang diterima target, berurutan */
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }[];
  wss: WebSocketServer;
  close(): Promise<void>;
}

/** Target server palsu: HTTP + HTTPS (self-signed) dengan beberapa endpoint, plus WebSocket echo. */
export async function startTarget(): Promise<Target> {
  const seen: Target['seen'] = [];

  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, rawHeaders: req.rawHeaders, body });
      const url = new URL(req.url!, 'http://x');

      if (url.pathname === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-server': 'real' });
        return res.end('hello-from-server');
      }
      if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, headers: req.headers, body }),
        );
      }
      if (url.pathname === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        return res.end(gzipSync('compressed-original'));
      }
      if (url.pathname === '/bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
      }
      if (url.pathname === '/json') {
        const payload = JSON.stringify({ role: 'user', n: 1 });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          'set-cookie': ['sid=abc123; Path=/; HttpOnly', 'theme=dark'],
        });
        return res.end(payload);
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
  };

  const ca = await generateCACertificate({ subject: { commonName: 'localhost', organizationName: 'Target' } });
  const httpServer = http.createServer(handler);
  const httpsServer = https.createServer({ key: ca.key, cert: ca.cert }, handler);
  await new Promise<void>((r) => httpServer.listen(0, r));
  await new Promise<void>((r) => httpsServer.listen(0, r));

  // WebSocket echo di server HTTP yang sama
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (sock) => {
    sock.on('message', (data, isBinary) => sock.send(isBinary ? data : `echo:${data.toString()}`, { binary: isBinary }));
  });
  // dan di server HTTPS (wss)
  const wssTls = new WebSocketServer({ server: httpsServer, path: '/ws' });
  wssTls.on('connection', (sock) => {
    sock.on('message', (data, isBinary) => sock.send(isBinary ? data : `echo:${data.toString()}`, { binary: isBinary }));
  });

  return {
    http: httpServer,
    https: httpsServer,
    httpPort: (httpServer.address() as AddressInfo).port,
    httpsPort: (httpsServer.address() as AddressInfo).port,
    cert: ca.cert,
    seen,
    wss,
    async close() {
      wss.close();
      wssTls.close();
      httpServer.closeAllConnections();
      httpsServer.closeAllConnections();
      await new Promise((r) => httpServer.close(r));
      await new Promise((r) => httpsServer.close(r));
    },
  };
}

export interface ClientResult {
  status: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  /** CN issuer sertifikat yang diterima client (hanya HTTPS) */
  issuerCN?: string;
}

export interface ViaProxyOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** CA yang dipercaya client untuk HTTPS */
  ca?: string;
  timeoutMs?: number;
  onRequest?: (req: http.ClientRequest) => void;
}

/** HTTP client yang lewat proxy (absolute-URI untuk http, CONNECT + TLS untuk https). Tidak auto-decode body. */
export function viaProxy(proxyPort: number, target: string, o: ViaProxyOptions = {}): Promise<ClientResult> {
  const url = new URL(target);
  const method = o.method ?? 'GET';
  const headers = { host: url.host, ...(o.headers ?? {}) };
  if (o.body !== undefined && !('content-length' in headers) && !('Content-Length' in headers)) {
    headers['content-length'] = String(Buffer.byteLength(o.body));
  }

  return new Promise<ClientResult>((resolve, reject) => {
    const finish = (req: http.ClientRequest, issuerCN?: string) => {
      req.setTimeout(o.timeoutMs ?? 10_000, () => req.destroy(new Error('client timeout')));
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
            issuerCN,
          }),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
      o.onRequest?.(req);
      req.end(o.body);
    };

    if (url.protocol === 'http:') {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: target,
        method,
        headers,
        agent: false,
      });
      return finish(req);
    }

    // HTTPS: CONNECT dulu, lalu TLS di atas tunnel
    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${url.hostname}:${url.port || 443}`,
      agent: false,
    });
    connectReq.on('error', reject);
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT gagal: ${res.statusCode}`));
      const tlsSocket = tls.connect({ socket, servername: url.hostname, ca: o.ca });
      tlsSocket.on('error', reject);
      tlsSocket.on('secureConnect', () => {
        const issuerCN = (tlsSocket.getPeerCertificate().issuer as { CN?: string } | undefined)?.CN;
        // Pola resmi: agent kustom yang mengembalikan socket tunnel (agent:false mengabaikan createConnection).
        const agent = new https.Agent({ keepAlive: false });
        (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () => tlsSocket;
        const req = https.request({
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          agent,
        });
        finish(req, issuerCN);
      });
    });
    connectReq.end();
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tunggu sampai predicate true (polling) atau timeout. */
export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, label = 'kondisi'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await sleep(20);
  }
}
