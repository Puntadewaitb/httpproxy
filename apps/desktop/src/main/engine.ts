import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import {
  InterceptQueue,
  ProxyServer,
  Repeater,
  Store,
  emptyScope,
  exportHar,
  loadOrCreateCA,
  type CertAuthority,
  type HeldItem,
  type InterceptSettings,
  type ListFilter,
  type RequestSnapshot,
  type ResponseSnapshot,
  type Scope,
} from '@proxykit/core';
import type {
  AppSettings,
  BodyDTO,
  CannedResponseDTO,
  DropMode,
  ExchangeDTO,
  HeldItemDTO,
  LogEntry,
  ProxyStatus,
  RepeaterRequestDTO,
  RepeaterResultDTO,
  RequestDTO,
  RequestEditDTO,
  ResolvedDTO,
  ResponseDTO,
  ResponseEditDTO,
  WsMessageDTO,
} from '../shared/api.js';

export const defaultSettings = (): AppSettings => ({
  port: 8080,
  tlsPassthrough: [],
  ignoreUpstreamCertErrors: false,
  intercept: { requests: false, responses: false, scope: emptyScope(), timeoutMs: 0, onTimeout: 'forward' },
});

export function toBody(buf: Buffer | Uint8Array): BodyDTO {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return { size: b.length, text: isUtf8(b) ? b.toString('utf8') : null, b64: b.toString('base64') };
}

const reqDTO = (r: RequestSnapshot): RequestDTO => ({ ...r, body: toBody(r.body) });
const resDTO = (r: ResponseSnapshot): ResponseDTO => ({ ...r, body: toBody(r.body) });

const heldDTO = (h: HeldItem): HeldItemDTO => ({
  key: h.key,
  exchangeId: h.exchangeId,
  kind: h.kind,
  heldAt: h.heldAt,
  request: reqDTO(h.request),
  response: h.response ? resDTO(h.response) : undefined,
});

/** Validasi regex scope di sini: regex invalid akan throw di setiap request kalau lolos ke core. */
export function validateScope(scope: Scope): void {
  for (const [list, rules] of [['include', scope.include], ['exclude', scope.exclude]] as const) {
    rules.forEach((r, i) => {
      for (const field of ['host', 'path'] as const) {
        const v = r[field];
        if (!v) continue;
        try {
          new RegExp(v);
        } catch (e) {
          throw new Error(`Scope ${list} #${i + 1}: regex ${field} tidak valid (${(e as Error).message})`);
        }
      }
    });
  }
}

export interface EngineEvents {
  'history-changed': [ids: string[]];
  held: [item: HeldItemDTO];
  resolved: [info: ResolvedDTO];
  log: [entry: LogEntry];
  status: [status: ProxyStatus];
}

/** Satu instance per app: CA + Store + InterceptQueue hidup terus, ProxyServer dibuat ulang saat setting jaringan berubah. */
export class Engine extends EventEmitter<EngineEvents> {
  readonly store: Store;
  readonly queue = new InterceptQueue();
  private repeater: Repeater;
  private proxy: ProxyServer | null = null;
  private ca: CertAuthority | null = null;
  private settings: AppSettings;
  private lastError: string | null = null;
  private logBuf: LogEntry[] = [];
  private logSeq = 0;
  private pendingIds = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly settingsPath: string;

  constructor(readonly dataDir: string, private overridePort?: number) {
    super();
    this.settingsPath = join(dataDir, 'desktop-settings.json');
    this.settings = this.loadSettings();
    this.store = new Store(join(dataDir, 'history.db'));
    this.repeater = new Repeater(this.store);
    this.queue.configure(this.settings.intercept);

    this.queue.on('held', (item) => this.emit('held', heldDTO(item)));
    this.queue.on('resolved', ({ key, exchangeId, kind, decision, reason }) => {
      this.emit('resolved', { key, exchangeId, kind, action: decision.action, reason });
      if (reason === 'timeout') this.log('info', 'intercept', `Timeout: ${kind} ${exchangeId} otomatis di-${decision.action}`);
    });
  }

  private loadSettings(): AppSettings {
    const d = defaultSettings();
    if (!existsSync(this.settingsPath)) return d;
    try {
      const s = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<AppSettings>;
      const intercept = { ...d.intercept, ...s.intercept };
      try {
        validateScope(intercept.scope);
      } catch {
        intercept.scope = emptyScope();
      }
      // Jangan pernah start dengan intercept aktif dari sesi lalu: traffic bisa ketahan tanpa disadari.
      return { ...d, ...s, intercept: { ...intercept, requests: false, responses: false } };
    } catch {
      return d;
    }
  }

  private saveSettings(): void {
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }

  log(level: LogEntry['level'], kind: LogEntry['kind'], message: string, extra: Partial<LogEntry> = {}): void {
    const entry: LogEntry = { id: ++this.logSeq, ts: Date.now(), level, kind, message, ...extra };
    this.logBuf.push(entry);
    if (this.logBuf.length > 1000) this.logBuf.splice(0, this.logBuf.length - 1000);
    this.emit('log', entry);
  }

  logs(): LogEntry[] {
    return this.logBuf;
  }

  /** Event `exchange` bisa ratusan per detik: kumpulkan id lalu kirim ke UI tiap 150 ms. */
  private touch(id: string): void {
    this.pendingIds.add(id);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const ids = [...this.pendingIds];
      this.pendingIds.clear();
      this.emit('history-changed', ids);
      void this.pushStatus(); // historyCount di topbar
    }, 150);
  }

  async status(): Promise<ProxyStatus> {
    const port = this.proxy ? this.proxy.port : null;
    const addresses: string[] = [];
    if (port !== null) {
      addresses.push(`127.0.0.1:${port}`);
      for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addresses.push(`${a.address}:${port}`);
      }
    }
    return {
      running: !!this.proxy,
      port,
      error: this.lastError,
      addresses,
      dataDir: this.dataDir,
      caCertPath: this.ca?.certPath ?? null,
      caFingerprint: this.ca?.fingerprint ?? null,
      settings: this.settings,
      heldCount: this.queue.size,
      historyCount: this.store.count(),
    };
  }

  private async pushStatus(): Promise<ProxyStatus> {
    const s = await this.status();
    this.emit('status', s);
    return s;
  }

  async start(): Promise<ProxyStatus> {
    if (this.proxy) return this.status();
    this.ca ??= await loadOrCreateCA(this.dataDir);
    if (this.ca.created) this.log('info', 'proxy', `CA baru dibuat: ${this.ca.certPath}. Install & trust di device/browser target.`);
    const proxy = new ProxyServer({
      store: this.store,
      ca: this.ca,
      queue: this.queue,
      tlsPassthrough: this.settings.tlsPassthrough,
      ignoreUpstreamCertErrors: this.settings.ignoreUpstreamCertErrors,
    });
    proxy.on('exchange', ({ id }) => this.touch(id));
    proxy.on('tls-error', (e) =>
      this.log('warn', 'tls-error', `TLS handshake ditolak client (${e.cause}). CA belum trusted atau app pakai pinning.`, {
        hostname: e.hostname,
        remoteIp: e.remoteIp,
      }),
    );
    proxy.on('client-error', (e) => this.log('error', 'client-error', e.message));
    const port = this.overridePort ?? this.settings.port;
    try {
      await proxy.start(port);
      this.proxy = proxy;
      this.lastError = null;
      this.log('info', 'proxy', `Proxy listen di port ${proxy.port}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = /EADDRINUSE/.test(msg) ? `Port ${port} sudah dipakai proses lain` : msg;
      this.log('error', 'proxy', `Gagal start proxy: ${this.lastError}`);
      await proxy.stop().catch(() => {});
    }
    return this.pushStatus();
  }

  async stop(): Promise<ProxyStatus> {
    const p = this.proxy;
    this.proxy = null;
    if (p) {
      await p.stop();
      this.log('info', 'proxy', 'Proxy dihentikan');
    }
    return this.pushStatus();
  }

  async updateSettings(patch: Partial<Omit<AppSettings, 'intercept'>>): Promise<ProxyStatus> {
    if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 0 || patch.port > 65535)) {
      throw new Error('Port harus 0-65535');
    }
    const next = { ...this.settings, ...patch, intercept: this.settings.intercept };
    if (patch.tlsPassthrough) next.tlsPassthrough = patch.tlsPassthrough.map((h) => h.trim()).filter(Boolean);
    const needsRestart =
      next.port !== this.settings.port ||
      JSON.stringify(next.tlsPassthrough) !== JSON.stringify(this.settings.tlsPassthrough) ||
      next.ignoreUpstreamCertErrors !== this.settings.ignoreUpstreamCertErrors;
    this.settings = next;
    this.saveSettings();
    if (needsRestart) {
      if (patch.port !== undefined) this.overridePort = undefined;
      if (this.proxy) {
        await this.stop();
        return this.start();
      }
    }
    return this.pushStatus();
  }

  async configureIntercept(patch: Partial<InterceptSettings>): Promise<ProxyStatus> {
    if (patch.scope) validateScope(patch.scope);
    if (patch.timeoutMs !== undefined && (!Number.isFinite(patch.timeoutMs) || patch.timeoutMs < 0)) {
      throw new Error('Timeout tidak valid');
    }
    this.queue.configure(patch);
    this.settings = { ...this.settings, intercept: this.queue.settings };
    this.saveSettings();
    return this.pushStatus();
  }

  // ---- History ----

  listHistory(filter: ListFilter) {
    return this.store.list({ limit: 2000, ...filter });
  }

  getExchange(id: string): ExchangeDTO | null {
    const e = this.store.get(id);
    if (!e) return null;
    return {
      ...e,
      request: reqDTO(e.request),
      response: e.response ? resDTO(e.response) : null,
      requestOriginal: e.requestOriginal ? reqDTO(e.requestOriginal) : null,
      responseOriginal: e.responseOriginal ? resDTO(e.responseOriginal) : null,
    };
  }

  listWs(id: string): WsMessageDTO[] {
    return this.store.listWs(id).map((m) => ({
      seq: m.seq,
      direction: m.direction,
      isBinary: m.isBinary,
      body: toBody(m.content),
      ts: m.ts,
    }));
  }

  clearHistory(): void {
    this.store.clear();
    this.emit('history-changed', []);
    void this.pushStatus();
  }

  har(filter: ListFilter): string {
    return JSON.stringify(exportHar(this.store, filter), null, 2);
  }

  // ---- Intercept ----

  listHeld(): HeldItemDTO[] {
    return this.queue.list().map(heldDTO);
  }

  forward(key: string, edit?: RequestEditDTO | ResponseEditDTO): boolean {
    const ok = this.queue.forward(key, edit);
    void this.pushStatus();
    return ok;
  }

  drop(key: string, mode: DropMode, response?: CannedResponseDTO): boolean {
    const ok = this.queue.drop(key, mode, response);
    void this.pushStatus();
    return ok;
  }

  forwardAll(): number {
    const n = this.queue.forwardAll();
    void this.pushStatus();
    return n;
  }

  dropAll(): number {
    const n = this.queue.dropAll();
    void this.pushStatus();
    return n;
  }

  // ---- Repeater ----

  async sendRepeater(req: RepeaterRequestDTO, parentId?: string): Promise<RepeaterResultDTO> {
    const r = await this.repeater.send(
      { method: req.method, url: req.url, headers: req.headers, body: req.body, insecure: req.insecure, timeoutMs: req.timeoutMs },
      { parentId },
    );
    this.touch(r.id);
    return {
      id: r.id,
      request: reqDTO(r.request),
      response: r.response ? resDTO(r.response) : null,
      durationMs: r.durationMs,
      error: r.error,
    };
  }

  caCertPem(): string | null {
    return this.ca?.cert ?? null;
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.proxy?.stop().catch(() => {});
    this.proxy = null;
    this.store.close();
  }
}
