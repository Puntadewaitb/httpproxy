import { EventEmitter } from 'node:events';
import { getLocal } from 'mockttp';
import type { CompletedRequest, Mockttp } from 'mockttp';
import type { CertAuthority } from './ca.js';
import { getHeader, removeHeader, toBuffer, toHeadersObject, toRawHeaders } from './headers.js';
import { InterceptQueue } from './intercept.js';
import type { Store } from './store.js';
import type {
  RawHeaders,
  RequestEdit,
  RequestSnapshot,
  ResponseEdit,
  ResponseSnapshot,
} from './types.js';

export interface ProxyOptions {
  store: Store;
  ca: CertAuthority;
  queue?: InterceptQueue;
  /** Hostname (wildcard boleh, mis. "*.apple.com") yang TLS-nya TIDAK diintercept. Berguna untuk app dengan pinning. */
  tlsPassthrough?: string[];
  /** Abaikan error sertifikat upstream (self-signed di target lab). true = semua, atau daftar host. */
  ignoreUpstreamCertErrors?: boolean | string[];
}

export interface ProxyEvents {
  /** Ada exchange baru atau berubah (request masuk / response selesai / state berubah). */
  exchange: [info: { id: string; phase: 'request' | 'response' | 'state' | 'ws-message' }];
  /** Client menolak sertifikat proxy (CA belum trusted atau app pakai pinning). */
  'tls-error': [info: { hostname?: string; cause: string; remoteIp?: string }];
  'client-error': [info: { message: string }];
}

const EMPTY = Buffer.alloc(0);

function snapRequest(req: CompletedRequest, body: Buffer): RequestSnapshot {
  return {
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    headers: req.rawHeaders.map(([k, v]) => [k, v] as [string, string]),
    body,
  };
}

/** Terapkan edit ke snapshot untuk dapat versi "effective" (yang benar-benar dikirim). */
export function applyRequestEdit(snap: RequestSnapshot, edit: RequestEdit): RequestSnapshot {
  return {
    ...snap,
    method: edit.method ?? snap.method,
    url: edit.url ?? snap.url,
    headers: edit.headers ? toRawHeaders(edit.headers) : snap.headers,
    body: toBuffer(edit.body) ?? snap.body,
  };
}

export function applyResponseEdit(snap: ResponseSnapshot, edit: ResponseEdit): ResponseSnapshot {
  return {
    ...snap,
    statusCode: edit.statusCode ?? snap.statusCode,
    statusMessage: edit.statusMessage ?? snap.statusMessage,
    headers: edit.headers ? toRawHeaders(edit.headers) : snap.headers,
    body: toBuffer(edit.body) ?? snap.body,
  };
}

const sameHeaders = (a: RawHeaders, b: RawHeaders) => JSON.stringify(a) === JSON.stringify(b);

function requestChanged(a: RequestSnapshot, b: RequestSnapshot): boolean {
  return a.method !== b.method || a.url !== b.url || !sameHeaders(a.headers, b.headers) || !a.body.equals(b.body);
}

function responseChanged(a: ResponseSnapshot, b: ResponseSnapshot): boolean {
  return (
    a.statusCode !== b.statusCode ||
    a.statusMessage !== b.statusMessage ||
    !sameHeaders(a.headers, b.headers) ||
    !a.body.equals(b.body)
  );
}

/**
 * mockttp menimpa `host` & `content-length` (lowercase) di atas object header dari callback.
 * Kalau user menulis `Host` / `Content-Length`, hasilnya header dobel di wire (upstream membalas 400).
 * Jadi dua header itu dinormalisasi ke lowercase; header lain tetap casing asli.
 */
function headersForMockttp(h: RawHeaders) {
  return toHeadersObject(
    h.map(([k, v]) => {
      const l = k.toLowerCase();
      return [l === 'host' || l === 'content-length' ? l : k, v] as [string, string];
    }),
  );
}

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export class ProxyServer extends EventEmitter<ProxyEvents> {
  readonly store: Store;
  readonly queue: InterceptQueue;
  readonly ca: CertAuthority;
  private server: Mockttp | null = null;
  private opts: ProxyOptions;

  constructor(opts: ProxyOptions) {
    super();
    this.opts = opts;
    this.store = opts.store;
    this.ca = opts.ca;
    this.queue = opts.queue ?? new InterceptQueue();
  }

  /** Bungkus handler event: error internal (mis. DB) tidak boleh jadi unhandled rejection. */
  private safe<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => Promise<void> {
    return async (...a: A) => {
      try {
        await fn(...a);
      } catch (e) {
        this.emit('client-error', { message: `internal: ${e instanceof Error ? e.message : String(e)}` });
      }
    };
  }

  get port(): number {
    if (!this.server) throw new Error('Proxy belum jalan');
    return this.server.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 8080): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error('Proxy sudah jalan');
    const { store, queue } = this;

    const server = getLocal({
      https: {
        key: this.ca.key,
        cert: this.ca.cert,
        ...(this.opts.tlsPassthrough?.length
          ? { tlsPassthrough: this.opts.tlsPassthrough.map((hostname) => ({ hostname })) }
          : {}),
      },
      // Body disimpan sendiri di SQLite, jadi tidak perlu rekam di memori mockttp.
      recordTraffic: false,
      cors: false,
    });

    await server.forAnyRequest().thenPassThrough({
      ignoreHostHttpsErrors: this.opts.ignoreUpstreamCertErrors ?? false,

      beforeRequest: async (req) => {
        const body = (await req.body.getDecodedBuffer()) ?? EMPTY;
        const snap = snapRequest(req, body);
        store.insertExchange({
          id: req.id,
          startedAt: req.timingEvents.startTime,
          protocol: req.protocol,
          httpVersion: req.httpVersion,
          request: snap,
        });
        this.emit('exchange', { id: req.id, phase: 'request' });

        if (!queue.shouldHold('request', snap.method, snap.url)) return;

        const decision = await queue.hold({ exchangeId: req.id, kind: 'request', request: snap });

        if (decision.action === 'drop') {
          if (!decision.cancelled) {
            store.setState(req.id, 'dropped');
            this.emit('exchange', { id: req.id, phase: 'state' });
          }
          if (decision.mode === 'respond' && decision.response) {
            return {
              response: {
                statusCode: decision.response.statusCode,
                headers: decision.response.headers ? toHeadersObject(decision.response.headers) : undefined,
                body: decision.response.body,
              },
            };
          }
          return { response: decision.mode === 'reset' ? 'reset' : 'close' };
        }

        const edit = decision.edit as RequestEdit | undefined;
        if (!edit) return;
        const effective = applyRequestEdit(snap, edit);
        if (!requestChanged(snap, effective)) return;

        store.setRequestEdit(req.id, effective, snap);

        const result: {
          method?: string;
          url?: string;
          headers?: ReturnType<typeof toHeadersObject>;
          body?: Buffer;
        } = {};
        if (effective.method !== snap.method) result.method = effective.method.toUpperCase();
        if (effective.url !== snap.url) result.url = effective.url;
        if (!sameHeaders(effective.headers, snap.headers)) {
          let headers = effective.headers;
          // URL host berubah tapi user tidak menyentuh header Host -> biarkan mockttp
          // menyesuaikan Host, supaya request tidak terkirim dengan Host yang salah.
          const newHost = hostOfUrl(effective.url);
          if (
            effective.url !== snap.url &&
            newHost !== hostOfUrl(snap.url) &&
            getHeader(headers, 'host') === getHeader(snap.headers, 'host')
          ) {
            headers = removeHeader(headers, 'host');
          }
          result.headers = headersForMockttp(headers);
        }
        if (!effective.body.equals(snap.body)) result.body = effective.body;
        return result;
      },

      beforeResponse: async (res, req) => {
        const body = (await res.body.getDecodedBuffer()) ?? EMPTY;
        const snap: ResponseSnapshot = {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage ?? '',
          headers: res.rawHeaders.map(([k, v]) => [k, v] as [string, string]),
          body,
        };
        if (!queue.shouldHold('response', req.method, req.url)) return;

        const reqBody = (await req.body.getDecodedBuffer()) ?? EMPTY;
        const decision = await queue.hold({
          exchangeId: res.id,
          kind: 'response',
          request: snapRequest(req, reqBody),
          response: snap,
        });

        if (decision.action === 'drop') {
          if (!decision.cancelled) {
            store.setState(res.id, 'dropped');
            this.emit('exchange', { id: res.id, phase: 'state' });
          }
          if (decision.mode === 'respond' && decision.response) {
            return {
              statusCode: decision.response.statusCode,
              headers: decision.response.headers ? toHeadersObject(decision.response.headers) : undefined,
              body: decision.response.body,
            };
          }
          return decision.mode === 'reset' ? 'reset' : 'close';
        }

        const edit = decision.edit as ResponseEdit | undefined;
        if (!edit) return;
        const effective = applyResponseEdit(snap, edit);
        if (!responseChanged(snap, effective)) return;

        store.setResponseOriginal(res.id, snap);

        const result: {
          statusCode?: number;
          statusMessage?: string;
          headers?: ReturnType<typeof toHeadersObject>;
          body?: Buffer;
        } = {};
        if (effective.statusCode !== snap.statusCode) result.statusCode = effective.statusCode;
        if (effective.statusMessage !== snap.statusMessage) result.statusMessage = effective.statusMessage;
        if (!sameHeaders(effective.headers, snap.headers)) result.headers = headersForMockttp(effective.headers);
        if (!effective.body.equals(snap.body)) result.body = effective.body;
        return result;
      },
    });

    await server.forAnyWebSocket().thenPassThrough({
      ignoreHostHttpsErrors: this.opts.ignoreUpstreamCertErrors ?? false,
    });

    // ---- Capture: response final yang diterima client ----
    await server.on('response', this.safe(async (res) => {
      const body = (await res.body.getDecodedBuffer().catch(() => undefined)) ?? EMPTY;
      const t = res.timingEvents;
      const dur =
        t.responseSentTimestamp !== undefined && t.startTimestamp !== undefined
          ? t.responseSentTimestamp - t.startTimestamp
          : null;
      store.saveResponse(
        res.id,
        {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage ?? '',
          headers: res.rawHeaders.map(([k, v]) => [k, v] as [string, string]),
          body,
        },
        dur,
      );
      this.emit('exchange', { id: res.id, phase: 'response' });
    }));

    await server.on('abort', this.safe((req) => {
      queue.cancel(req.id);
      store.markAborted(req.id);
      this.emit('exchange', { id: req.id, phase: 'state' });
    }));

    // ---- WebSocket ----
    await server.on('websocket-request', this.safe(async (req) => {
      const body = (await req.body.getDecodedBuffer().catch(() => undefined)) ?? EMPTY;
      store.insertExchange({
        id: req.id,
        startedAt: req.timingEvents.startTime,
        protocol: req.protocol,
        httpVersion: req.httpVersion,
        request: snapRequest(req, body),
      });
      this.emit('exchange', { id: req.id, phase: 'request' });
    }));
    await server.on('websocket-accepted', this.safe(async (res) => {
      store.saveResponse(
        res.id,
        {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage ?? '',
          headers: res.rawHeaders.map(([k, v]) => [k, v] as [string, string]),
          body: EMPTY,
        },
        null,
      );
      this.emit('exchange', { id: res.id, phase: 'response' });
    }));
    const wsMsg = (dir: 'c2s' | 's2c') => this.safe((m: import('mockttp').WebSocketMessage) => {
      const t = m.timingEvents;
      store.insertWsMessage({
        streamId: m.streamId,
        direction: dir,
        isBinary: m.isBinary,
        content: Buffer.from(m.content),
        ts: t.startTime + (m.eventTimestamp - t.startTimestamp),
      });
      this.emit('exchange', { id: m.streamId, phase: 'ws-message' });
    });
    // 'received' = diterima Mockttp dari client; 'sent' = dikirim Mockttp ke client.
    await server.on('websocket-message-received', wsMsg('c2s'));
    await server.on('websocket-message-sent', wsMsg('s2c'));
    await server.on('websocket-close', this.safe((c) => {
      store.setWsClose(c.streamId, c.closeCode, c.closeReason);
      this.emit('exchange', { id: c.streamId, phase: 'state' });
    }));

    // ---- Diagnostik ----
    await server.on('tls-client-error', (e) => {
      this.emit('tls-error', {
        hostname: e.tlsMetadata?.sniHostname ?? e.destination?.hostname,
        cause: e.failureCause,
        remoteIp: e.remoteIpAddress,
      });
    });
    await server.on('client-error', (e) => {
      this.emit('client-error', { message: e.errorCode ?? 'client error' });
    });

    await server.start(port);
    this.server = server;
    return { port: server.port, url: this.url };
  }

  async stop(): Promise<void> {
    this.queue.dropAll();
    await this.server?.stop();
    this.server = null;
  }
}
