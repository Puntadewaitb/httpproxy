// Parse / serialize pesan HTTP mentah untuk editor intercept & repeater.
// Pure function tanpa Buffer supaya jalan di renderer (browser) maupun test Node.
import type { BodyDTO, RawHeaders, RequestDTO, RequestEditDTO, ResponseDTO, ResponseEditDTO } from './api';

const enc = new TextEncoder();
export const byteLength = (s: string): number => enc.encode(s).length;

export const binaryPlaceholder = (size: number): string =>
  `<<binary body ${size} bytes: tidak bisa diedit di mode teks, biarkan baris ini untuk mempertahankan body asli>>`;

/** Body sebagai teks editor. Binary diganti placeholder supaya tidak rusak lewat textarea. */
export function bodyText(b: BodyDTO): string {
  if (b.size === 0) return '';
  return b.text ?? binaryPlaceholder(b.size);
}

const headerLines = (h: RawHeaders) => h.map(([k, v]) => `${k}: ${v}`).join('\n');

function joinMessage(startLine: string, headers: RawHeaders, body: string): string {
  const head = headers.length ? `${startLine}\n${headerLines(headers)}` : startLine;
  return `${head}\n\n${body}`;
}

export function serializeRequest(req: RequestDTO, form: 'absolute' | 'origin' = 'absolute'): string {
  let target = req.url;
  if (form === 'origin') {
    try {
      const u = new URL(req.url);
      target = u.pathname + u.search;
    } catch {
      /* biarkan absolut */
    }
  }
  return joinMessage(`${req.method} ${target} HTTP/${req.httpVersion || '1.1'}`, req.headers, bodyText(req.body));
}

export function serializeResponse(res: ResponseDTO, httpVersion = '1.1'): string {
  const reason = res.statusMessage ? ` ${res.statusMessage}` : '';
  return joinMessage(`HTTP/${httpVersion} ${res.statusCode}${reason}`, res.headers, bodyText(res.body));
}

export interface ParsedMessage {
  startLine: string[];
  headers: RawHeaders;
  body: string;
}

export class RawHttpError extends Error {}

function splitMessage(text: string): ParsedMessage {
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text.replace(/\r?\n$/, '');
  const body = m ? text.slice(m.index + m[0].length) : '';
  const lines = head.split(/\r?\n/);
  // Toleransi baris kosong di awal (sisa copy-paste).
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (!lines.length) throw new RawHttpError('Pesan kosong');
  const startLine = lines[0].trim().split(/\s+/);
  const headers: RawHeaders = [];
  lines.slice(1).forEach((line, i) => {
    const idx = line.indexOf(':');
    if (idx <= 0) throw new RawHttpError(`Header tidak valid di baris ${i + 2}: "${line}"`);
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).replace(/^[ \t]+/, '')]);
  });
  return { startLine, headers, body };
}

export interface ParsedRequest {
  method: string;
  /** Absolute URL atau origin-form (/path?q). */
  target: string;
  httpVersion: string;
  headers: RawHeaders;
  body: string;
}

export function parseRequest(text: string): ParsedRequest {
  const { startLine, headers, body } = splitMessage(text);
  const [method, target, version] = startLine;
  if (!method || !target) throw new RawHttpError('Request line harus berbentuk "METHOD target HTTP/1.1"');
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(method)) throw new RawHttpError(`Method tidak valid: ${method}`);
  return { method, target, httpVersion: (version ?? 'HTTP/1.1').replace(/^HTTP\//i, ''), headers, body };
}

export interface ParsedResponse {
  statusCode: number;
  statusMessage: string;
  headers: RawHeaders;
  body: string;
}

export function parseResponse(text: string): ParsedResponse {
  const { startLine, headers, body } = splitMessage(text);
  const [version, code, ...reason] = startLine;
  const statusCode = Number(code);
  if (!/^HTTP\//i.test(version ?? '') || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
    throw new RawHttpError('Status line harus berbentuk "HTTP/1.1 200 OK"');
  }
  return { statusCode, statusMessage: reason.join(' '), headers, body };
}

const hasHeader = (h: RawHeaders, name: string) => h.some(([k]) => k.toLowerCase() === name);

/** Set Content-Length = panjang body (byte), kecuali pakai chunked. Header lain tidak disentuh. */
export function withContentLength(h: RawHeaders, body: string, addIfMissing: boolean): RawHeaders {
  if (hasHeader(h, 'transfer-encoding')) return h;
  const len = String(byteLength(body));
  if (hasHeader(h, 'content-length')) return h.map(([k, v]) => [k, k.toLowerCase() === 'content-length' ? len : v]);
  return addIfMissing && body.length ? [...h, ['Content-Length', len]] : h;
}

const sameHeaders = (a: RawHeaders, b: RawHeaders) => JSON.stringify(a) === JSON.stringify(b);
const normalizeNl = (s: string) => s.replace(/\r\n/g, '\n');

/** Body editor sama dengan body asli? (textarea menormalisasi CRLF jadi LF, jadi bandingkan versi ternormalisasi). */
function bodyUnchanged(original: BodyDTO, edited: string): boolean {
  if (original.text === null) return edited === binaryPlaceholder(original.size);
  return normalizeNl(original.text) === normalizeNl(edited);
}

export interface EditOptions {
  /** Update Content-Length otomatis kalau body diubah (default true). */
  updateContentLength?: boolean;
}

/** Hitung edit minimal dari teks editor. undefined = tidak ada perubahan (forward apa adanya). */
export function requestEditFrom(original: RequestDTO, text: string, opts: EditOptions = {}): RequestEditDTO | undefined {
  const p = parseRequest(text);
  const edit: RequestEditDTO = {};
  if (p.method !== original.method) edit.method = p.method;

  let url = p.target;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    // origin-form: resolve terhadap origin URL asli
    try {
      url = new URL(url, original.url).toString();
    } catch {
      throw new RawHttpError(`Target tidak valid: ${p.target}`);
    }
  }
  if (url !== original.url) edit.url = url;

  let headers = p.headers;
  const bodyChanged = !bodyUnchanged(original.body, p.body);
  if (bodyChanged) {
    if (original.body.text === null && p.body.includes('<<binary body')) {
      throw new RawHttpError('Placeholder body binary diubah sebagian. Kembalikan placeholder utuh, atau ganti seluruh body.');
    }
    edit.body = p.body;
    if (opts.updateContentLength !== false) headers = withContentLength(headers, p.body, false);
  }
  if (!sameHeaders(headers, original.headers)) edit.headers = headers;
  return Object.keys(edit).length ? edit : undefined;
}

export function responseEditFrom(original: ResponseDTO, text: string, opts: EditOptions = {}): ResponseEditDTO | undefined {
  const p = parseResponse(text);
  const edit: ResponseEditDTO = {};
  if (p.statusCode !== original.statusCode) edit.statusCode = p.statusCode;
  if (p.statusMessage !== original.statusMessage) edit.statusMessage = p.statusMessage;

  let headers = p.headers;
  if (!bodyUnchanged(original.body, p.body)) {
    if (original.body.text === null && p.body.includes('<<binary body')) {
      throw new RawHttpError('Placeholder body binary diubah sebagian. Kembalikan placeholder utuh, atau ganti seluruh body.');
    }
    edit.body = p.body;
    if (opts.updateContentLength !== false) headers = withContentLength(headers, p.body, false);
  }
  if (!sameHeaders(headers, original.headers)) edit.headers = headers;
  return Object.keys(edit).length ? edit : undefined;
}

/**
 * Request repeater dari teks editor. `base` (mis. https://api.target.com) dipakai kalau
 * request line berbentuk origin-form; kalau kosong, diambil dari header Host + https.
 */
export function repeaterRequestFrom(
  base: string,
  text: string,
  opts: EditOptions = {},
): { method: string; url: string; headers: RawHeaders; body: string } {
  const p = parseRequest(text);
  let url: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p.target)) {
    url = p.target;
  } else {
    const host = p.headers.find(([k]) => k.toLowerCase() === 'host')?.[1];
    const origin = base.trim() || (host ? `https://${host}` : '');
    if (!origin) throw new RawHttpError('Isi Target (mis. https://api.target.com) atau header Host');
    if (!p.target.startsWith('/')) throw new RawHttpError('Target request line harus absolute URL atau diawali "/"');
    try {
      url = new URL(origin).origin + p.target;
    } catch {
      throw new RawHttpError(`Target tidak valid: ${origin}`);
    }
  }
  const headers = opts.updateContentLength === false ? p.headers : withContentLength(p.headers, p.body, true);
  return { method: p.method, url, headers, body: p.body };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Copy as cURL. Content-Length dibuang (curl hitung sendiri); body binary tidak disertakan. */
export function toCurl(req: RequestDTO): string {
  const parts = ['curl', '-k', '--path-as-is', '-X', req.method, shq(req.url)];
  for (const [k, v] of req.headers) {
    if (k.toLowerCase() === 'content-length') continue;
    parts.push('-H', shq(`${k}: ${v}`));
  }
  if (req.body.size > 0) {
    if (req.body.text !== null) parts.push('--data-binary', shq(req.body.text));
    else parts.push(`# body binary ${req.body.size} bytes tidak disertakan`);
  }
  return parts.join(' ');
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
