// Kontrak IPC main <-> renderer. Hanya type + konstanta, aman di-import dari ketiga sisi.
import type {
  DropMode,
  ExchangeState,
  ExchangeSummary,
  InterceptKind,
  InterceptSettings,
  ListFilter,
  RawHeaders,
  ResolveReason,
  Scope,
} from '@proxykit/core';

export type { ExchangeSummary, InterceptSettings, ListFilter, RawHeaders, Scope, DropMode, InterceptKind };

/** Body lewat IPC: `text` terisi kalau UTF-8 valid, `b64` selalu ada (buat hex view / binary). */
export interface BodyDTO {
  size: number;
  text: string | null;
  b64: string;
}

export interface RequestDTO {
  method: string;
  url: string;
  httpVersion: string;
  headers: RawHeaders;
  body: BodyDTO;
}

export interface ResponseDTO {
  statusCode: number;
  statusMessage: string;
  headers: RawHeaders;
  body: BodyDTO;
}

export interface ExchangeDTO extends ExchangeSummary {
  httpVersion: string;
  request: RequestDTO;
  response: ResponseDTO | null;
  requestOriginal: RequestDTO | null;
  responseOriginal: ResponseDTO | null;
  error: string | null;
  wsCloseCode: number | null;
  wsCloseReason: string | null;
  state: ExchangeState;
}

export interface WsMessageDTO {
  seq: number;
  direction: 'c2s' | 's2c';
  isBinary: boolean;
  body: BodyDTO;
  ts: number;
}

export interface HeldItemDTO {
  key: string;
  exchangeId: string;
  kind: InterceptKind;
  heldAt: number;
  request: RequestDTO;
  response?: ResponseDTO;
}

export interface ResolvedDTO {
  key: string;
  exchangeId: string;
  kind: InterceptKind;
  action: 'forward' | 'drop';
  reason: ResolveReason;
}

/** Edit dari renderer. Body string = UTF-8; field kosong = tidak diubah. */
export interface RequestEditDTO {
  method?: string;
  url?: string;
  headers?: RawHeaders;
  body?: string;
}

export interface ResponseEditDTO {
  statusCode?: number;
  statusMessage?: string;
  headers?: RawHeaders;
  body?: string;
}

export interface CannedResponseDTO {
  statusCode: number;
  headers: RawHeaders;
  body: string;
}

export interface RepeaterRequestDTO {
  method: string;
  url: string;
  headers: RawHeaders;
  body: string;
  insecure: boolean;
  timeoutMs: number;
}

export interface RepeaterResultDTO {
  id: string;
  request: RequestDTO;
  response: ResponseDTO | null;
  durationMs: number;
  error?: string;
}

export interface AppSettings {
  port: number;
  /** Hostname (wildcard boleh) yang TLS-nya tidak di-MITM. */
  tlsPassthrough: string[];
  ignoreUpstreamCertErrors: boolean;
  intercept: InterceptSettings;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
  error: string | null;
  /** Alamat LAN buat setting proxy di device mobile. */
  addresses: string[];
  dataDir: string;
  caCertPath: string | null;
  caFingerprint: string | null;
  settings: AppSettings;
  heldCount: number;
  historyCount: number;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  kind: 'tls-error' | 'client-error' | 'proxy' | 'intercept';
  message: string;
  hostname?: string;
  remoteIp?: string;
}

/** API yang di-expose preload ke `window.proxykit`. */
export interface ProxyKitApi {
  status(): Promise<ProxyStatus>;
  startProxy(): Promise<ProxyStatus>;
  stopProxy(): Promise<ProxyStatus>;
  /** Simpan setting; proxy di-restart kalau port / passthrough / insecure berubah. */
  updateSettings(patch: Partial<Omit<AppSettings, 'intercept'>>): Promise<ProxyStatus>;
  configureIntercept(patch: Partial<InterceptSettings>): Promise<ProxyStatus>;

  listHistory(filter: ListFilter): Promise<ExchangeSummary[]>;
  getExchange(id: string): Promise<ExchangeDTO | null>;
  listWs(id: string): Promise<WsMessageDTO[]>;
  clearHistory(): Promise<void>;
  exportHar(filter: ListFilter): Promise<string | null>;

  listHeld(): Promise<HeldItemDTO[]>;
  forward(key: string, edit?: RequestEditDTO | ResponseEditDTO): Promise<boolean>;
  drop(key: string, mode: DropMode, response?: CannedResponseDTO): Promise<boolean>;
  forwardAll(): Promise<number>;
  dropAll(): Promise<number>;

  sendRepeater(req: RepeaterRequestDTO, parentId?: string): Promise<RepeaterResultDTO>;

  exportCA(): Promise<string | null>;
  openDataDir(): Promise<void>;
  copyText(text: string): Promise<void>;
  logs(): Promise<LogEntry[]>;

  onHistoryChanged(cb: (ids: string[]) => void): () => void;
  onHeld(cb: (item: HeldItemDTO) => void): () => void;
  onResolved(cb: (info: ResolvedDTO) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;
  onStatus(cb: (status: ProxyStatus) => void): () => void;
}

/** Nama channel IPC. invoke = request/response, event = main -> renderer. */
export const IPC = {
  invoke: [
    'status',
    'startProxy',
    'stopProxy',
    'updateSettings',
    'configureIntercept',
    'listHistory',
    'getExchange',
    'listWs',
    'clearHistory',
    'exportHar',
    'listHeld',
    'forward',
    'drop',
    'forwardAll',
    'dropAll',
    'sendRepeater',
    'exportCA',
    'openDataDir',
    'copyText',
    'logs',
  ],
  events: {
    historyChanged: 'evt:history-changed',
    held: 'evt:held',
    resolved: 'evt:resolved',
    log: 'evt:log',
    status: 'evt:status',
  },
} as const;

export type InvokeChannel = (typeof IPC.invoke)[number];
