/** Header pairs, urutan dan casing asli dipertahankan (penting buat testing). */
export type RawHeaders = [string, string][];
export type HeadersObject = Record<string, string | string[]>;
export type HeadersInput = RawHeaders | HeadersObject;

export interface RequestSnapshot {
  method: string;
  url: string;
  httpVersion: string;
  headers: RawHeaders;
  body: Buffer;
}

export interface ResponseSnapshot {
  statusCode: number;
  statusMessage: string;
  headers: RawHeaders;
  body: Buffer;
}

/** Edit yang diterapkan user ke request yang ditahan. Field yang tidak diisi = tidak diubah. */
export interface RequestEdit {
  method?: string;
  url?: string;
  headers?: HeadersInput;
  body?: Buffer | string;
}

export interface ResponseEdit {
  statusCode?: number;
  statusMessage?: string;
  headers?: HeadersInput;
  body?: Buffer | string;
}

export type ExchangeSource = 'proxy' | 'repeater';
export type ExchangeState = 'pending' | 'ok' | 'dropped' | 'aborted' | 'error' | 'closed';

export interface ExchangeSummary {
  seq: number;
  id: string;
  source: ExchangeSource;
  parentId: string | null;
  startedAt: number;
  protocol: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  reqSize: number;
  respSize: number | null;
  state: ExchangeState;
  modified: boolean;
}

export interface Exchange extends ExchangeSummary {
  httpVersion: string;
  request: RequestSnapshot;
  response: ResponseSnapshot | null;
  /** Request asli dari client, hanya ada kalau diedit sebelum diteruskan. */
  requestOriginal: RequestSnapshot | null;
  /** Response asli dari server, hanya ada kalau diedit sebelum dikirim ke client. */
  responseOriginal: ResponseSnapshot | null;
  error: string | null;
  wsCloseCode: number | null;
  wsCloseReason: string | null;
}

export interface WsMessage {
  seq: number;
  streamId: string;
  /** c2s = client -> server, s2c = server -> client */
  direction: 'c2s' | 's2c';
  isBinary: boolean;
  content: Buffer;
  ts: number;
}

export interface ScopeRule {
  /** Regex (string) terhadap hostname. */
  host?: string;
  /** Regex (string) terhadap path + query. */
  path?: string;
  /** Daftar method, case-insensitive. */
  methods?: string[];
  /** http | https | ws | wss */
  protocols?: string[];
}

export interface Scope {
  /** Kosong = semua traffic masuk scope. */
  include: ScopeRule[];
  exclude: ScopeRule[];
}
