import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';
import { getHeader, hasHeader, toBuffer, toRawHeaders } from './headers.js';
import type { Store } from './store.js';
import type { HeadersInput, RawHeaders, RequestSnapshot, ResponseSnapshot } from './types.js';

export interface RepeaterRequest {
  method: string;
  url: string;
  headers?: HeadersInput;
  body?: Buffer | string;
  /** Abaikan error sertifikat TLS target (self-signed di lab). Default false. */
  insecure?: boolean;
  /** Default 30000 ms. */
  timeoutMs?: number;
}

export interface RepeaterResult {
  id: string;
  request: RequestSnapshot;
  /** Body sudah di-decode (gzip/deflate/br) untuk dibaca. */
  response: ResponseSnapshot | null;
  /** Body persis seperti diterima dari server (masih ter-encode). */
  rawBody: Buffer;
  durationMs: number;
  error?: string;
}

export function decodeBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding || body.length === 0) return body;
  try {
    // Content-Encoding bisa berlapis: "gzip, br" -> decode dari yang terakhir.
    let out = body;
    const encs = contentEncoding.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).reverse();
    for (const enc of encs) {
      if (enc === 'gzip' || enc === 'x-gzip') out = gunzipSync(out);
      else if (enc === 'br') out = brotliDecompressSync(out);
      else if (enc === 'deflate') {
        try {
          out = inflateSync(out);
        } catch {
          out = inflateRawSync(out);
        }
      } else if (enc !== 'identity') return body; // encoding tidak dikenal (mis. zstd): kembalikan apa adanya
    }
    return out;
  } catch {
    return body;
  }
}

export class Repeater {
  constructor(private store: Store) {}

  /** Kirim request langsung ke target (tanpa lewat proxy) dan simpan ke history (source = repeater). */
  async send(req: RepeaterRequest, opts: { parentId?: string } = {}): Promise<RepeaterResult> {
    const id = randomUUID();
    const url = new URL(req.url);
    const isHttps = url.protocol === 'https:';
    if (!isHttps && url.protocol !== 'http:') throw new Error(`Protocol tidak didukung: ${url.protocol}`);

    const body = toBuffer(req.body) ?? Buffer.alloc(0);
    let headers: RawHeaders = req.headers ? toRawHeaders(req.headers) : [];
    // Header dikirim sebagai array mentah (casing/duplikat/urutan dipertahankan), jadi Node tidak
    // menambah Host otomatis: tambahkan di depan kalau user tidak menyediakannya.
    if (!hasHeader(headers, 'host')) headers = [['Host', url.host], ...headers];
    if (body.length > 0 && !hasHeader(headers, 'content-length') && !hasHeader(headers, 'transfer-encoding')) {
      headers = [...headers, ['Content-Length', String(body.length)]];
    }
    const reqSnap: RequestSnapshot = { method: req.method.toUpperCase(), url: req.url, httpVersion: '1.1', headers, body };

    const startedAt = Date.now();
    this.store.insertExchange({
      id,
      source: 'repeater',
      parentId: opts.parentId,
      startedAt,
      protocol: url.protocol.replace(':', ''),
      httpVersion: '1.1',
      request: reqSnap,
    });

    const t0 = performance.now();
    try {
      const { statusCode, statusMessage, rawHeaders, raw } = await new Promise<{
        statusCode: number;
        statusMessage: string;
        rawHeaders: RawHeaders;
        raw: Buffer;
      }>((resolve, reject) => {
        const lib = isHttps ? https : http;
        const r = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: reqSnap.method,
            headers: headers.flat(),
            agent: false,
            rejectUnauthorized: !req.insecure,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const pairs: RawHeaders = [];
              for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
              resolve({
                statusCode: res.statusCode ?? 0,
                statusMessage: res.statusMessage ?? '',
                rawHeaders: pairs,
                raw: Buffer.concat(chunks),
              });
            });
            res.on('error', reject);
          },
        );
        r.setTimeout(req.timeoutMs ?? 30_000, () => r.destroy(new Error(`Timeout setelah ${req.timeoutMs ?? 30_000} ms`)));
        r.on('error', reject);
        r.end(body);
      });

      const durationMs = performance.now() - t0;
      const decoded = decodeBody(raw, getHeader(rawHeaders, 'content-encoding'));
      const response: ResponseSnapshot = { statusCode, statusMessage, headers: rawHeaders, body: decoded };
      this.store.saveResponse(id, response, durationMs);
      return { id, request: reqSnap, response, rawBody: raw, durationMs };
    } catch (e) {
      const durationMs = performance.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      this.store.setState(id, 'error', message);
      return { id, request: reqSnap, response: null, rawBody: Buffer.alloc(0), durationMs, error: message };
    }
  }
}
