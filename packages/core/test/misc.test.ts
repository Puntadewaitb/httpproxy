import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import {
  InterceptQueue,
  ProxyServer,
  Repeater,
  Store,
  exportHar,
  inScope,
  loadOrCreateCA,
  toHeadersObject,
  toRawHeaders,
} from '../src/index.js';
import type { CertAuthority } from '../src/index.js';
import { startTarget, tmp, viaProxy, waitFor } from './helpers.js';
import type { Target } from './helpers.js';

const require = createRequire(import.meta.url);
// har-validator = validasi terhadap skema HAR 1.2 resmi (har-schema)
const harValidator = require('har-validator') as { log: (data: unknown) => Promise<boolean> };

let target: Target;
let ca: CertAuthority;
let store: Store;
let queue: InterceptQueue;
let proxy: ProxyServer;
let port: number;

const HTTP = () => `http://localhost:${target.httpPort}`;
const HTTPS = () => `https://localhost:${target.httpsPort}`;

before(async () => {
  target = await startTarget();
  ca = await loadOrCreateCA(tmp());
});
after(async () => {
  await target.close();
});
beforeEach(async () => {
  store = new Store();
  queue = new InterceptQueue();
  proxy = new ProxyServer({ store, ca, queue, ignoreUpstreamCertErrors: true });
  ({ port } = await proxy.start(0));
  target.seen.length = 0;
});
afterEach(async () => {
  await proxy.stop();
  store.close();
});

describe('header utils', () => {
  it('duplikat dan urutan dipertahankan; object <-> pairs konsisten', () => {
    const raw = toRawHeaders([
      ['Set-Cookie', 'a=1'],
      ['X-Y', '1'],
      ['Set-Cookie', 'b=2'],
    ]);
    assert.deepEqual(raw.map(([k]) => k), ['Set-Cookie', 'X-Y', 'Set-Cookie']);
    assert.deepEqual(toHeadersObject(raw), { 'Set-Cookie': ['a=1', 'b=2'], 'X-Y': '1' });
    assert.deepEqual(toRawHeaders({ 'Set-Cookie': ['a=1', 'b=2'], 'X-Y': '1' }), [
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['X-Y', '1'],
    ]);
  });
});

describe('scope', () => {
  const t = (method: string, url: string) => ({ method, url });
  it('include kosong = semua; exclude selalu menang', () => {
    assert.equal(inScope({ include: [], exclude: [] }, t('GET', 'https://a.com/x')), true);
    assert.equal(inScope({ include: [], exclude: [{ host: 'a\\.com$' }] }, t('GET', 'https://a.com/x')), false);
    assert.equal(
      inScope({ include: [{ host: 'a\\.com$' }], exclude: [{ path: '^/static/' }] }, t('GET', 'https://a.com/static/x.js')),
      false,
    );
  });
  it('host regex anchored, method, protocol, query ikut path', () => {
    const scope = { include: [{ host: '^api\\.bank\\.co\\.id$', methods: ['post', 'PUT'], protocols: ['https'], path: 'v1/.*\\?x=1' }], exclude: [] };
    assert.equal(inScope(scope, t('POST', 'https://api.bank.co.id/v1/pay?x=1')), true);
    assert.equal(inScope(scope, t('GET', 'https://api.bank.co.id/v1/pay?x=1')), false);
    assert.equal(inScope(scope, t('POST', 'http://api.bank.co.id/v1/pay?x=1')), false);
    assert.equal(inScope(scope, t('POST', 'https://evil.api.bank.co.id.attacker.com/v1/pay?x=1')), false, 'host harus anchored');
    assert.equal(inScope(scope, t('POST', 'https://api.bank.co.id/v1/pay?x=2')), false);
  });
});

describe('store', () => {
  it('pencarian literal (karakter spesial LIKE/regex tidak diperlakukan sebagai pola) dan pagination', () => {
    const mk = (id: string, url: string, body: string) =>
      store.insertExchange({
        id,
        startedAt: Date.now(),
        protocol: 'http',
        httpVersion: '1.1',
        request: { method: 'POST', url, httpVersion: '1.1', headers: [], body: Buffer.from(body) },
      });
    mk('1', 'http://a.test/x', '100%_sure');
    mk('2', 'http://a.test/y', 'plain');
    mk('3', 'http://a.test/z', 'a.*b');
    assert.deepEqual(store.list({ q: '100%_' }).map((s) => s.id), ['1']);
    assert.deepEqual(store.list({ q: '%' }).map((s) => s.id), ['1']);
    assert.deepEqual(store.list({ q: 'a.*b' }).map((s) => s.id), ['3']);
    assert.deepEqual(store.list({ order: 'asc', limit: 2 }).map((s) => s.id), ['1', '2']);
    assert.deepEqual(store.list({ order: 'asc', limit: 2, offset: 2 }).map((s) => s.id), ['3']);
    assert.deepEqual(store.list().map((s) => s.id), ['3', '2', '1'], 'default terbaru dulu');
  });

  it('operasi tulis setelah close tidak melempar error', () => {
    const s = new Store();
    s.close();
    assert.doesNotThrow(() => s.setState('x', 'ok'));
  });
});

describe('fidelity header ke upstream (lewat proxy)', () => {
  it('nilai header sampai utuh; casing dinormalisasi lowercase oleh mockttp (batasan yang diketahui)', async () => {
    await viaProxy(port, `${HTTP()}/echo`, {
      headers: { 'X-Mixed-CaSe': 'v1', 'x-lower': 'v2' },
    });
    const seen = target.seen.at(-1)!;
    assert.equal(seen.headers['x-mixed-case'], 'v1');
    assert.equal(seen.headers['x-lower'], 'v2');
    // history tetap menyimpan casing asli dari client
    const e = store.get(store.list()[0].id)!;
    assert.ok(e.request.headers.some(([k]) => k === 'X-Mixed-CaSe'));
    // Dokumentasi batasan: kalau casing perlu dikontrol persis di wire, pakai Repeater (raw header).
    const names = seen.rawHeaders.filter((_, i) => i % 2 === 0);
    assert.ok(names.includes('x-mixed-case'), `perilaku mockttp berubah? names=${names.join(',')}`);
  });
});

describe('Repeater', () => {
  it('GET: hasil + tersimpan sebagai source=repeater dengan parentId', async () => {
    const parent = await viaProxy(port, `${HTTP()}/hello`);
    assert.equal(parent.status, 200);
    const orig = await waitFor(() => store.list({ source: 'proxy' })[0], 3000, 'orig');
    const rp = new Repeater(store);
    const r = await rp.send({ method: 'get', url: `${HTTP()}/hello` }, { parentId: orig.id });
    assert.equal(r.response!.statusCode, 200);
    assert.equal(r.response!.body.toString(), 'hello-from-server');
    const [row] = store.list({ source: 'repeater' });
    assert.equal(row.parentId, orig.id);
    assert.equal(row.state, 'ok');
    assert.equal(row.method, 'GET');
    assert.ok(row.durationMs! >= 0);
    // repeater tidak lewat proxy -> history 'proxy' tidak bertambah
    assert.equal(store.list({ source: 'proxy' }).length, 1);
  });

  it('POST: Content-Length otomatis, header casing + duplikat terkirim apa adanya', async () => {
    const rp = new Repeater(store);
    const r = await rp.send({
      method: 'POST',
      url: `${HTTP()}/echo`,
      headers: [
        ['Content-Type', 'text/plain'],
        ['X-Dup', 'one'],
        ['X-Dup', 'two'],
        ['X-CaSe', 'keep'],
      ],
      body: 'payload-123',
    });
    const echoed = JSON.parse(r.response!.body.toString());
    assert.equal(echoed.body, 'payload-123');
    assert.equal(echoed.headers['content-length'], '11');
    assert.equal(echoed.headers['x-dup'], 'one, two');
    const seen = target.seen.at(-1)!;
    assert.ok(seen.rawHeaders.includes('X-CaSe'));
    assert.equal(seen.rawHeaders.filter((h) => h === 'X-Dup').length, 2);
  });

  it('gzip: response.body ter-decode, rawBody tetap gzip', async () => {
    const r = await new Repeater(store).send({ method: 'GET', url: `${HTTP()}/gzip`, headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.response!.body.toString(), 'compressed-original');
    assert.equal(r.rawBody[0], 0x1f);
    assert.equal(r.rawBody[1], 0x8b);
  });

  it('HTTPS self-signed: gagal tanpa insecure (tercatat state=error), sukses dengan insecure', async () => {
    const rp = new Repeater(store);
    const bad = await rp.send({ method: 'GET', url: `${HTTPS()}/hello` });
    assert.equal(bad.response, null);
    assert.match(bad.error!, /self-signed|self signed|unable to verify/i);
    assert.equal(store.get(bad.id)!.state, 'error');

    const ok = await rp.send({ method: 'GET', url: `${HTTPS()}/hello`, insecure: true });
    assert.equal(ok.response!.statusCode, 200);
  });

  it('target tidak terjangkau / timeout: tidak melempar, mengembalikan error', async () => {
    const rp = new Repeater(store);
    const refused = await rp.send({ method: 'GET', url: 'http://127.0.0.1:1/', timeoutMs: 2000 });
    assert.equal(refused.response, null);
    assert.match(refused.error!, /ECONNREFUSED/);
    assert.equal(store.get(refused.id)!.state, 'error');
  });

  it('protocol selain http/https ditolak', async () => {
    await assert.rejects(new Repeater(store).send({ method: 'GET', url: 'ftp://x/y' }), /Protocol/);
  });
});

describe('HAR export', () => {
  it('valid terhadap skema HAR 1.2 resmi, field request/response benar', async () => {
    await viaProxy(port, `${HTTP()}/echo?a=1&b=two`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'sid=xyz; theme=dark' },
      body: '{"k":"v"}',
    });
    await viaProxy(port, `${HTTP()}/json`);
    await viaProxy(port, `${HTTP()}/bin`);
    await viaProxy(port, `${HTTPS()}/hello`, { ca: ca.cert });
    await waitFor(() => store.list().filter((s) => s.status !== null).length === 4, 5000, '4 selesai');

    const har = exportHar(store);
    await harValidator.log(har.log).catch((e: { errors?: unknown[] }) => {
      assert.fail(`HAR tidak valid: ${JSON.stringify(e.errors ?? e, null, 1)}`);
    });

    const { entries } = har.log as { entries: any[] };
    assert.equal(entries.length, 4);
    const echo = entries[0];
    assert.equal(echo.request.method, 'POST');
    assert.deepEqual(echo.request.queryString, [
      { name: 'a', value: '1' },
      { name: 'b', value: 'two' },
    ]);
    assert.deepEqual(echo.request.cookies, [
      { name: 'sid', value: 'xyz' },
      { name: 'theme', value: 'dark' },
    ]);
    assert.equal(echo.request.postData.mimeType, 'application/json');
    assert.equal(echo.request.postData.text, '{"k":"v"}');
    assert.equal(echo.response.status, 200);

    const json = entries[1];
    assert.deepEqual(json.response.cookies.map((c: any) => c.name), ['sid', 'theme']);
    assert.equal(json.response.content.text, '{"role":"user","n":1}');
    assert.equal(json.response.bodySize, 21);

    const bin = entries[2];
    assert.equal(bin.response.content.encoding, 'base64');
    assert.equal(Buffer.from(bin.response.content.text, 'base64').toString('hex'), 'fffe008081');

    assert.equal(entries[3].request.url, `${HTTPS()}/hello`);
    // urutan kronologis
    const times = entries.map((e) => Date.parse(e.startedDateTime));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('entry hasil edit ditandai (_modified) dan memakai versi yang benar-benar dikirim', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/echo`, { method: 'POST', body: 'before' });
    const held = await waitFor(() => queue.list()[0], 3000, 'held');
    queue.forward(held.key, { body: 'after' });
    await p;
    await waitFor(() => store.list()[0]?.status === 200, 3000, 'done');
    const [e] = (exportHar(store).log as { entries: any[] }).entries;
    assert.equal(e._modified, true);
    assert.equal(e.request.postData.text, 'after');
  });

  it('request gagal (dropped) tetap valid di HAR', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/hello`).catch(() => 'err');
    queue.drop((await waitFor(() => queue.list()[0], 3000, 'held')).key, 'close');
    await p;
    await waitFor(() => store.list()[0]?.state === 'dropped', 3000, 'dropped');
    const har = exportHar(store);
    await harValidator.log(har.log).catch((e: { errors?: unknown[] }) => assert.fail(JSON.stringify(e.errors ?? e)));
    assert.equal((har.log.entries[0] as any)._state, 'dropped');
  });

  it('WebSocket: pesan masuk ke _webSocketMessages; filter dan HAR tetap valid', async () => {
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
    const ws = new WebSocket(`ws://localhost:${target.httpPort}/ws`, { agent });
    await new Promise<void>((res, rej) => (ws.on('open', res), ws.on('error', rej)));
    const echoed = new Promise<string>((res) => ws.on('message', (d) => res(d.toString())));
    ws.send('hi');
    assert.equal(await echoed, 'echo:hi');
    ws.close(1000);
    await waitFor(() => store.list({ status: 101 })[0]?.state === 'closed', 5000, 'ws closed');
    await waitFor(() => store.listWs(store.list()[0].id).length === 2, 5000, 'ws msgs');

    const har = exportHar(store, { status: 101 });
    await harValidator.log(har.log).catch((e: { errors?: unknown[] }) => assert.fail(JSON.stringify(e.errors ?? e)));
    const entry = har.log.entries[0] as any;
    assert.equal(entry.response.status, 101);
    assert.deepEqual(
      entry._webSocketMessages.map((m: any) => [m.type, m.opcode, m.data]).sort(),
      [['receive', 1, 'echo:hi'], ['send', 1, 'hi']],
    );
  });
});
