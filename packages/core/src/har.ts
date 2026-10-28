import { isUtf8 } from 'node:buffer';
import { getHeader } from './headers.js';
import type { ListFilter, Store } from './store.js';
import type { Exchange, RawHeaders } from './types.js';

type HarHeader = { name: string; value: string };

const toHar = (h: RawHeaders): HarHeader[] => h.map(([name, value]) => ({ name, value }));

function parseCookieHeader(v: string | undefined): { name: string; value: string }[] {
  if (!v) return [];
  return v
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) };
    });
}

function parseSetCookies(h: RawHeaders): { name: string; value: string }[] {
  return h
    .filter(([k]) => k.toLowerCase() === 'set-cookie')
    .map(([, v]) => {
      const first = v.split(';')[0];
      const i = first.indexOf('=');
      return i < 0 ? { name: first, value: '' } : { name: first.slice(0, i), value: first.slice(i + 1) };
    });
}

function bodyText(b: Buffer): { text: string; encoding?: 'base64' } {
  if (b.length === 0) return { text: '' };
  return isUtf8(b) ? { text: b.toString('utf8') } : { text: b.toString('base64'), encoding: 'base64' };
}

function entry(ex: Exchange, ws: ReturnType<Store['listWs']>) {
  const req = ex.request;
  const res = ex.response;
  const ctReq = getHeader(req.headers, 'content-type') ?? '';
  const url = new URL(req.url);
  const total = ex.durationMs ?? 0;
  const resBody = res ? bodyText(res.body) : { text: '' };
  const clHeader = res ? getHeader(res.headers, 'content-length') : undefined;

  const e: Record<string, unknown> = {
    startedDateTime: new Date(ex.startedAt).toISOString(),
    time: total,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: `HTTP/${req.httpVersion}`,
      cookies: parseCookieHeader(getHeader(req.headers, 'cookie')),
      headers: toHar(req.headers),
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: req.body.length,
      ...(req.body.length
        ? (() => {
            const t = bodyText(req.body);
            return { postData: { mimeType: ctReq, text: t.text, ...(t.encoding ? { comment: 'base64' } : {}) } };
          })()
        : {}),
    },
    response: res
      ? {
          status: res.statusCode,
          statusText: res.statusMessage,
          httpVersion: `HTTP/${ex.httpVersion}`,
          cookies: parseSetCookies(res.headers),
          headers: toHar(res.headers),
          content: {
            size: res.body.length,
            mimeType: getHeader(res.headers, 'content-type') ?? '',
            text: resBody.text,
            ...(resBody.encoding ? { encoding: resBody.encoding } : {}),
          },
          redirectURL: getHeader(res.headers, 'location') ?? '',
          headersSize: -1,
          bodySize: clHeader && /^\d+$/.test(clHeader) ? Number(clHeader) : -1,
        }
      : {
          status: 0,
          statusText: '',
          httpVersion: `HTTP/${ex.httpVersion}`,
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
          _error: ex.error ?? ex.state,
        },
    cache: {},
    timings: { send: 0, wait: total, receive: 0 },
    _source: ex.source,
    _state: ex.state,
    _modified: ex.modified,
  };

  if (ws.length) {
    e._webSocketMessages = ws.map((m) => ({
      type: m.direction === 'c2s' ? 'send' : 'receive',
      time: m.ts / 1000,
      opcode: m.isBinary ? 2 : 1,
      data: m.isBinary ? m.content.toString('base64') : m.content.toString('utf8'),
    }));
  }
  return e;
}

/** Export history (dengan filter opsional) ke HAR 1.2, urut dari yang paling lama. */
export function exportHar(store: Store, filter: ListFilter = {}, creator = { name: 'ProxyKit', version: '0.1.0' }) {
  const summaries = store.list({ ...filter, order: 'asc', limit: filter.limit ?? 100_000 });
  const entries = [];
  for (const s of summaries) {
    const ex = store.get(s.id);
    if (!ex) continue;
    const isWs = ex.protocol === 'ws' || ex.protocol === 'wss';
    entries.push(entry(ex, isWs ? store.listWs(ex.id) : []));
  }
  return { log: { version: '1.2', creator, entries } };
}
