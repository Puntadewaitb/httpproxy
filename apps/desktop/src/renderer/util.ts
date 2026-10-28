import type { BodyDTO, RawHeaders } from '../shared/api';

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Hex dump ala xxd. Dibatasi supaya DOM tidak meledak untuk body besar. */
export function hexDump(b64: string, max = 64 * 1024): string {
  const bytes = b64ToBytes(b64);
  const n = Math.min(bytes.length, max);
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > n) lines.push(`... ${bytes.length - n} byte lagi tidak ditampilkan`);
  return lines.join('\n');
}

export function header(h: RawHeaders, name: string): string | undefined {
  const l = name.toLowerCase();
  return h.find(([k]) => k.toLowerCase() === l)?.[1];
}

/** Pretty print JSON / form-urlencoded kalau memungkinkan, selain itu null. */
export function prettyBody(body: BodyDTO, contentType: string | undefined): string | null {
  if (body.text === null || body.size === 0) return null;
  const t = body.text.trim();
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || /^[[{]/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* bukan JSON */
    }
  }
  if (ct.includes('x-www-form-urlencoded')) {
    try {
      return [...new URLSearchParams(t)].map(([k, v]) => `${k} = ${v}`).join('\n');
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function statusClass(status: number | null): string {
  if (status === null) return 's-none';
  return `s-${Math.floor(status / 100)}xx`;
}

export const errMsg = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  // Error dari ipcMain.handle dibungkus: "Error invoking remote method 'x': Error: pesan"
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};
