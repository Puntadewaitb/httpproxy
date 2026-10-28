import { EventEmitter } from 'node:events';
import { emptyScope, inScope } from './scope.js';
import type { RequestEdit, RequestSnapshot, ResponseEdit, ResponseSnapshot, Scope } from './types.js';

export type InterceptKind = 'request' | 'response';

export interface InterceptSettings {
  /** Tahan request sebelum dikirim ke server. */
  requests: boolean;
  /** Tahan response sebelum dikirim ke client. */
  responses: boolean;
  /** Hanya traffic dalam scope yang ditahan. Kosong = semua. */
  scope: Scope;
  /** Auto-resolve item yang kelamaan ditahan (ms). 0 = tanpa timeout. */
  timeoutMs: number;
  onTimeout: 'forward' | 'drop';
}

export type DropMode = 'close' | 'reset' | 'respond';

export type Decision =
  | { action: 'forward'; edit?: RequestEdit | ResponseEdit }
  | {
      action: 'drop';
      mode: DropMode;
      /** true kalau item dibuang karena client sudah putus (bukan keputusan user); jangan dicatat sebagai 'dropped'. */
      cancelled?: boolean;
      /** Dipakai kalau mode = 'respond' (hanya untuk kind = request). */
      response?: { statusCode: number; headers?: [string, string][]; body?: Buffer | string };
    };

export type ResolveReason = 'user' | 'timeout' | 'cancelled' | 'bulk';

export interface HeldItem {
  /** `${exchangeId}:request` atau `${exchangeId}:response` */
  key: string;
  exchangeId: string;
  kind: InterceptKind;
  heldAt: number;
  request: RequestSnapshot;
  response?: ResponseSnapshot;
}

interface Pending {
  item: HeldItem;
  resolve: (d: Decision) => void;
  timer?: NodeJS.Timeout;
}

export interface InterceptQueueEvents {
  held: [item: HeldItem];
  resolved: [info: { key: string; exchangeId: string; kind: InterceptKind; decision: Decision; reason: ResolveReason }];
}

export class InterceptQueue extends EventEmitter<InterceptQueueEvents> {
  settings: InterceptSettings = {
    requests: false,
    responses: false,
    scope: emptyScope(),
    timeoutMs: 0,
    onTimeout: 'forward',
  };

  private pending = new Map<string, Pending>();

  configure(patch: Partial<InterceptSettings>): void {
    this.settings = { ...this.settings, ...patch };
    // Toggle dimatikan -> lepas semua yang masih ketahan di kind tersebut.
    if (patch.requests === false) this.flush('request', 'forward');
    if (patch.responses === false) this.flush('response', 'forward');
  }

  shouldHold(kind: InterceptKind, method: string, url: string): boolean {
    const on = kind === 'request' ? this.settings.requests : this.settings.responses;
    return on && inScope(this.settings.scope, { method, url });
  }

  /** Tahan item sampai ada keputusan (user, timeout, atau cancel). */
  hold(input: { exchangeId: string; kind: InterceptKind; request: RequestSnapshot; response?: ResponseSnapshot }): Promise<Decision> {
    const key = `${input.exchangeId}:${input.kind}`;
    const item: HeldItem = { key, heldAt: Date.now(), ...input };
    return new Promise<Decision>((resolve) => {
      const p: Pending = { item, resolve };
      const { timeoutMs, onTimeout } = this.settings;
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.settle(key, onTimeout === 'forward' ? { action: 'forward' } : { action: 'drop', mode: 'close' }, 'timeout');
        }, timeoutMs);
        p.timer.unref?.();
      }
      this.pending.set(key, p);
      this.emit('held', item);
    });
  }

  list(): HeldItem[] {
    return [...this.pending.values()].map((p) => p.item).sort((a, b) => a.heldAt - b.heldAt);
  }

  get(key: string): HeldItem | undefined {
    return this.pending.get(key)?.item;
  }

  get size(): number {
    return this.pending.size;
  }

  forward(key: string, edit?: RequestEdit | ResponseEdit): boolean {
    return this.settle(key, { action: 'forward', edit }, 'user');
  }

  drop(key: string, mode: DropMode = 'close', response?: Extract<Decision, { action: 'drop' }>['response']): boolean {
    return this.settle(key, { action: 'drop', mode, response }, 'user');
  }

  /** Client sudah putus / abort: buang item tanpa mengeksekusi keputusan apa pun. */
  cancel(exchangeId: string): void {
    for (const kind of ['request', 'response'] as const) {
      this.settle(`${exchangeId}:${kind}`, { action: 'drop', mode: 'close', cancelled: true }, 'cancelled');
    }
  }

  forwardAll(): number {
    return this.flush(undefined, 'forward');
  }

  dropAll(): number {
    return this.flush(undefined, 'drop');
  }

  private flush(kind: InterceptKind | undefined, how: 'forward' | 'drop'): number {
    let n = 0;
    for (const [key, p] of [...this.pending]) {
      if (kind && p.item.kind !== kind) continue;
      this.settle(key, how === 'forward' ? { action: 'forward' } : { action: 'drop', mode: 'close' }, 'bulk');
      n++;
    }
    return n;
  }

  private settle(key: string, decision: Decision, reason: ResolveReason): boolean {
    const p = this.pending.get(key);
    if (!p) return false;
    this.pending.delete(key);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(decision);
    this.emit('resolved', { key, exchangeId: p.item.exchangeId, kind: p.item.kind, decision, reason });
    return true;
  }
}
