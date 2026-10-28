import type { HeadersInput, HeadersObject, RawHeaders } from './types.js';

export function isRawHeaders(h: HeadersInput): h is RawHeaders {
  return Array.isArray(h);
}

/** Normalisasi input header apa pun jadi array pair (urutan dipertahankan). */
export function toRawHeaders(h: HeadersInput): RawHeaders {
  if (isRawHeaders(h)) return h.map(([k, v]) => [k, String(v)]);
  const out: RawHeaders = [];
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const item of v) out.push([k, String(item)]);
    else if (v !== undefined) out.push([k, String(v)]);
  }
  return out;
}

/** Gabungkan header duplikat jadi array, dipakai untuk API mockttp / node http. */
export function toHeadersObject(h: HeadersInput): HeadersObject {
  const out: HeadersObject = {};
  for (const [k, v] of toRawHeaders(h)) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}

export function getHeader(h: RawHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  return h.find(([k]) => k.toLowerCase() === lower)?.[1];
}

export function hasHeader(h: RawHeaders, name: string): boolean {
  return getHeader(h, name) !== undefined;
}

export function removeHeader(h: RawHeaders, name: string): RawHeaders {
  const lower = name.toLowerCase();
  return h.filter(([k]) => k.toLowerCase() !== lower);
}

export function toBuffer(b: Buffer | string | undefined): Buffer | undefined {
  if (b === undefined) return undefined;
  return Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
}
