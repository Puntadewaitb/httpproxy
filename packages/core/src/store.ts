import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  Exchange,
  ExchangeSource,
  ExchangeState,
  ExchangeSummary,
  RawHeaders,
  RequestSnapshot,
  ResponseSnapshot,
  WsMessage,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exchanges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'proxy',
  parent_id TEXT,
  started_at INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  http_version TEXT NOT NULL DEFAULT '1.1',
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  req_headers TEXT NOT NULL,
  req_body BLOB NOT NULL,
  req_orig TEXT,
  status INTEGER,
  status_message TEXT,
  resp_headers TEXT,
  resp_body BLOB,
  resp_orig TEXT,
  duration_ms REAL,
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  ws_close_code INTEGER,
  ws_close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_exchanges_host ON exchanges(host);
CREATE INDEX IF NOT EXISTS idx_exchanges_started ON exchanges(started_at);
CREATE INDEX IF NOT EXISTS idx_exchanges_parent ON exchanges(parent_id);

CREATE TABLE IF NOT EXISTS ws_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_binary INTEGER NOT NULL,
  content BLOB NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_stream ON ws_messages(stream_id);
`;

export interface NewExchange {
  id: string;
  source?: ExchangeSource;
  parentId?: string;
  startedAt: number;
  protocol: string;
  httpVersion: string;
  request: RequestSnapshot;
}

export interface ListFilter {
  limit?: number;
  offset?: number;
  /** Substring match di hostname. */
  host?: string;
  method?: string;
  /** Status exact (200) atau kelas (2 => 2xx). */
  status?: number;
  source?: ExchangeSource;
  /** Substring (case-insensitive) di URL, request body, atau response body. */
  q?: string;
  /** Hanya yang diedit via intercept. */
  modifiedOnly?: boolean;
  order?: 'asc' | 'desc';
}

function hostOf(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return { host: '', path: url };
  }
}

/** node:sqlite mengembalikan BLOB sebagai Uint8Array; API Store tetap pakai Buffer. */
const buf = (v: Uint8Array | null): Buffer | null => (v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);

const snapJson = (s: RequestSnapshot | ResponseSnapshot): string =>
  JSON.stringify({ ...s, body: s.body.toString('base64') });

function parseSnap<T extends RequestSnapshot | ResponseSnapshot>(json: string | null): T | null {
  if (!json) return null;
  const o = JSON.parse(json);
  return { ...o, body: Buffer.from(o.body, 'base64') } as T;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  insertExchange(e: NewExchange): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    const { host, path } = hostOf(e.request.url);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO exchanges
         (id, source, parent_id, started_at, protocol, http_version, method, url, host, path, req_headers, req_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.source ?? 'proxy',
        e.parentId ?? null,
        Math.round(e.startedAt),
        e.protocol,
        e.httpVersion,
        e.request.method,
        e.request.url,
        host,
        path,
        JSON.stringify(e.request.headers),
        e.request.body,
      );
  }

  /** Request diedit user: kolom utama = yang diteruskan ke server, req_orig = aslinya. */
  setRequestEdit(id: string, effective: RequestSnapshot, original: RequestSnapshot): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    const { host, path } = hostOf(effective.url);
    this.db
      .prepare(
        `UPDATE exchanges SET method=?, url=?, host=?, path=?, req_headers=?, req_body=?, req_orig=? WHERE id=?`,
      )
      .run(
        effective.method,
        effective.url,
        host,
        path,
        JSON.stringify(effective.headers),
        effective.body,
        snapJson(original),
        id,
      );
  }

  setResponseOriginal(id: string, original: ResponseSnapshot): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db.prepare(`UPDATE exchanges SET resp_orig=? WHERE id=?`).run(snapJson(original), id);
  }

  saveResponse(id: string, r: ResponseSnapshot, durationMs: number | null): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db
      .prepare(
        `UPDATE exchanges SET status=?, status_message=?, resp_headers=?, resp_body=?, duration_ms=?,
         state = CASE WHEN state IN ('pending','ok') THEN 'ok' ELSE state END WHERE id=?`,
      )
      .run(r.statusCode, r.statusMessage, JSON.stringify(r.headers), r.body, durationMs, id);
  }

  setState(id: string, state: ExchangeState, error?: string): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db.prepare(`UPDATE exchanges SET state=?, error=COALESCE(?, error) WHERE id=?`).run(state, error ?? null, id);
  }

  /** Tandai aborted hanya kalau belum ada hasil lain (jangan timpa 'dropped'/'ok'). */
  markAborted(id: string): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db.prepare(`UPDATE exchanges SET state='aborted' WHERE id=? AND state='pending'`).run(id);
  }

  setWsClose(id: string, code: number | undefined, reason: string): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db
      .prepare(`UPDATE exchanges SET state='closed', ws_close_code=?, ws_close_reason=? WHERE id=?`)
      .run(code ?? null, reason, id);
  }

  insertWsMessage(m: Omit<WsMessage, 'seq'>): void {
    if (!this.db.isOpen) return; // event mockttp bisa tiba setelah store ditutup (shutdown)
    this.db
      .prepare(`INSERT INTO ws_messages (stream_id, direction, is_binary, content, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(m.streamId, m.direction, m.isBinary ? 1 : 0, m.content, Math.round(m.ts));
  }

  listWs(streamId: string): WsMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM ws_messages WHERE stream_id=? ORDER BY seq ASC`)
      .all(streamId) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      streamId: r.stream_id,
      direction: r.direction,
      isBinary: !!r.is_binary,
      content: buf(r.content)!,
      ts: r.ts,
    }));
  }

  private summary(r: any): ExchangeSummary {
    return {
      seq: r.seq,
      id: r.id,
      source: r.source,
      parentId: r.parent_id,
      startedAt: r.started_at,
      protocol: r.protocol,
      method: r.method,
      url: r.url,
      host: r.host,
      path: r.path,
      status: r.status,
      durationMs: r.duration_ms,
      reqSize: r.req_size ?? 0,
      respSize: r.resp_size,
      state: r.state,
      modified: !!(r.req_orig || r.resp_orig),
    };
  }

  list(f: ListFilter = {}): ExchangeSummary[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (f.host) {
      where.push(`instr(lower(host), lower(?)) > 0`);
      args.push(f.host);
    }
    if (f.method) {
      where.push(`method = ? COLLATE NOCASE`);
      args.push(f.method);
    }
    if (f.status !== undefined) {
      if (f.status < 10) {
        where.push(`status >= ? AND status < ?`);
        args.push(f.status * 100, f.status * 100 + 100);
      } else {
        where.push(`status = ?`);
        args.push(f.status);
      }
    }
    if (f.source) {
      where.push(`source = ?`);
      args.push(f.source);
    }
    if (f.modifiedOnly) where.push(`(req_orig IS NOT NULL OR resp_orig IS NOT NULL)`);
    if (f.q) {
      where.push(
        `(instr(lower(url), lower(?)) > 0
          OR instr(lower(CAST(req_body AS TEXT)), lower(?)) > 0
          OR instr(lower(CAST(resp_body AS TEXT)), lower(?)) > 0)`,
      );
      args.push(f.q, f.q, f.q);
    }
    const sql = `SELECT seq, id, source, parent_id, started_at, protocol, method, url, host, path, status,
        duration_ms, state, req_orig, resp_orig, length(req_body) AS req_size, length(resp_body) AS resp_size
      FROM exchanges ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY seq ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`;
    args.push(f.limit ?? 500, f.offset ?? 0);
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => this.summary(r));
  }

  get(id: string): Exchange | null {
    const r = this.db.prepare(`SELECT *, length(req_body) AS req_size, length(resp_body) AS resp_size FROM exchanges WHERE id=?`).get(id) as any;
    if (!r) return null;
    const headers = (s: string | null): RawHeaders => (s ? JSON.parse(s) : []);
    return {
      ...this.summary(r),
      httpVersion: r.http_version,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: r.http_version,
        headers: headers(r.req_headers),
        body: buf(r.req_body)!,
      },
      response:
        r.status === null
          ? null
          : {
              statusCode: r.status,
              statusMessage: r.status_message ?? '',
              headers: headers(r.resp_headers),
              body: buf(r.resp_body) ?? Buffer.alloc(0),
            },
      requestOriginal: parseSnap<RequestSnapshot>(r.req_orig),
      responseOriginal: parseSnap<ResponseSnapshot>(r.resp_orig),
      error: r.error,
      wsCloseCode: r.ws_close_code,
      wsCloseReason: r.ws_close_reason,
    };
  }

  count(): number {
    return (this.db.prepare(`SELECT count(*) AS c FROM exchanges`).get() as { c: number }).c;
  }

  clear(): void {
    this.db.exec(`DELETE FROM exchanges; DELETE FROM ws_messages;`);
  }
}
