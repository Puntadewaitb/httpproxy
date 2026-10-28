import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import { InterceptQueue, ProxyServer, Store, getHeader, loadOrCreateCA } from '../src/index.js';
import type { CertAuthority, Exchange } from '../src/index.js';
import { startTarget, tmp, viaProxy, waitFor, sleep } from './helpers.js';
import type { Target } from './helpers.js';

let target: Target;
let ca: CertAuthority;
let store: Store;
let queue: InterceptQueue;
let proxy: ProxyServer;
let port: number;

const HTTP = () => `http://localhost:${target.httpPort}`;
const HTTPS = () => `https://localhost:${target.httpsPort}`;

/** Ambil exchange dari store setelah response-nya tercatat. */
const exchangeWhere = (pred: (e: Exchange) => boolean, label: string) =>
  waitFor(() => {
    for (const s of store.list({ order: 'asc' })) {
      const e = store.get(s.id)!;
      if (pred(e) && (e.response || e.state !== 'pending')) return e;
    }
    return undefined;
  }, 5000, label);

const lastHeld = () => waitFor(() => queue.list()[0], 5000, 'item tertahan');

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

describe('CA', () => {
  it('generate sekali lalu reuse (fingerprint sama), private key 0600', async () => {
    const dir = tmp();
    const a = await loadOrCreateCA(dir);
    const b = await loadOrCreateCA(dir);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.fingerprint, b.fingerprint);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'ca-key.pem')).mode & 0o777, 0o600);
    const c = await loadOrCreateCA(tmp());
    assert.notEqual(a.fingerprint, c.fingerprint, 'tiap instalasi harus punya CA unik');
  });
});

describe('passthrough & capture', () => {
  it('HTTP: response sampai ke client dan tercatat di history', async () => {
    const r = await viaProxy(port, `${HTTP()}/hello?a=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'hello-from-server');
    assert.equal(r.headers['x-server'], 'real');

    const e = await exchangeWhere((x) => x.path === '/hello?a=1', 'hello');
    assert.equal(e.method, 'GET');
    assert.equal(e.status, 200);
    assert.equal(e.response!.body.toString(), 'hello-from-server');
    assert.equal(e.state, 'ok');
    assert.equal(e.modified, false);
    assert.ok(e.durationMs! >= 0);
  });

  it('HTTPS: traffic didecrypt, client menerima cert yang ditandatangani CA kita', async () => {
    const r = await viaProxy(port, `${HTTPS()}/hello`, { ca: ca.cert });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'hello-from-server');
    assert.equal(r.issuerCN, 'ProxyKit Root CA');

    const e = await exchangeWhere((x) => x.protocol === 'https', 'https');
    assert.equal(e.url, `${HTTPS()}/hello`);
    assert.equal(e.response!.body.toString(), 'hello-from-server');
  });

  it('HTTPS tanpa trust CA: client gagal dan proxy emit tls-error (indikasi CA belum trusted / pinning)', async () => {
    const errors: unknown[] = [];
    proxy.on('tls-error', (e) => errors.push(e));
    await assert.rejects(viaProxy(port, `${HTTPS()}/hello`)); // tanpa ca => cert proxy tidak dipercaya
    await waitFor(() => errors.length > 0, 3000, 'tls-error event');
    assert.equal(store.count(), 0);
  });

  it('POST body + header custom diteruskan apa adanya ke server', async () => {
    const r = await viaProxy(port, `${HTTP()}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Custom-Case': 'KeepMe' },
      body: '{"a":1}',
    });
    const echoed = JSON.parse(r.body.toString());
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, '{"a":1}');
    assert.equal(echoed.headers['x-custom-case'], 'KeepMe');
    // casing header dari client dipertahankan di history
    const e = await exchangeWhere((x) => x.path === '/echo', 'echo');
    assert.ok(e.request.headers.some(([k, v]) => k === 'X-Custom-Case' && v === 'KeepMe'));
    assert.equal(e.request.body.toString(), '{"a":1}');
  });

  it('body biner tersimpan utuh', async () => {
    const r = await viaProxy(port, `${HTTP()}/bin`);
    assert.deepEqual([...r.body], [0xff, 0xfe, 0x00, 0x80, 0x81]);
    const e = await exchangeWhere((x) => x.path === '/bin', 'bin');
    assert.deepEqual([...e.response!.body], [0xff, 0xfe, 0x00, 0x80, 0x81]);
  });

  it('response gzip: client dapat gzip asli, history menyimpan versi decoded', async () => {
    const r = await viaProxy(port, `${HTTP()}/gzip`);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(r.body).toString(), 'compressed-original');
    const e = await exchangeWhere((x) => x.path === '/gzip', 'gzip');
    assert.equal(e.response!.body.toString(), 'compressed-original');
  });

  it('filter list: host, method, status class, substring q', async () => {
    await viaProxy(port, `${HTTP()}/hello`);
    await viaProxy(port, `${HTTP()}/nothing-here`);
    await viaProxy(port, `${HTTP()}/echo`, { method: 'POST', body: 'needle-in-body' });
    await waitFor(() => store.list().filter((s) => s.status !== null).length === 3, 5000, '3 exchange');

    assert.equal(store.list({ method: 'post' }).length, 1);
    assert.equal(store.list({ status: 4 }).length, 1);
    assert.equal(store.list({ status: 404 })[0].path, '/nothing-here');
    assert.equal(store.list({ host: 'LOCALHOST' }).length, 3);
    assert.equal(store.list({ host: 'example.org' }).length, 0);
    assert.equal(store.list({ q: 'NEEDLE-in' }).length, 1, 'cari di request body');
    assert.ok(store.list({ q: 'hello-from' }).length >= 1, 'cari di response body');
  });
});

describe('intercept: request', () => {
  it('forward apa adanya', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    const held = await lastHeld();
    assert.equal(held.kind, 'request');
    assert.equal(held.request.method, 'GET');
    // selama ditahan, server target belum menerima apa pun
    await sleep(100);
    assert.equal(target.seen.length, 0);
    assert.ok(queue.forward(held.key));
    const r = await p;
    assert.equal(r.status, 200);
    assert.equal(target.seen.length, 1);
    const e = await exchangeWhere((x) => x.path === '/hello', 'hello');
    assert.equal(e.modified, false);
  });

  it('modify: method, header, body benar-benar sampai ke server; asli tersimpan', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' },
      body: '{"isAdmin":false}',
    });
    const held = await lastHeld();
    assert.equal(held.request.body.toString(), '{"isAdmin":false}');

    const headers = held.request.headers.map(([k, v]) =>
      k.toLowerCase() === 'authorization' ? ([k, 'Bearer admin-token'] as [string, string]) : ([k, v] as [string, string]),
    );
    headers.push(['X-Injected', 'yes']);
    queue.forward(held.key, { method: 'PUT', headers, body: '{"isAdmin":true}' });

    const r = await p;
    const echoed = JSON.parse(r.body.toString());
    assert.equal(echoed.method, 'PUT');
    assert.equal(echoed.body, '{"isAdmin":true}');
    assert.equal(echoed.headers.authorization, 'Bearer admin-token');
    assert.equal(echoed.headers['x-injected'], 'yes');
    assert.equal(echoed.headers['content-length'], String('{"isAdmin":true}'.length), 'content-length ikut diperbarui');

    const e = await exchangeWhere((x) => x.path === '/echo', 'echo');
    assert.equal(e.modified, true);
    assert.equal(e.request.method, 'PUT');
    assert.equal(e.request.body.toString(), '{"isAdmin":true}');
    assert.equal(e.requestOriginal!.method, 'POST');
    assert.equal(e.requestOriginal!.body.toString(), '{"isAdmin":false}');
    assert.ok(e.requestOriginal!.headers.some(([k, v]) => k.toLowerCase() === 'authorization' && v === 'Bearer user-token'));
  });

  it('modify hanya body: header lain tidak berubah', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/echo`, { method: 'POST', headers: { 'x-keep': '1' }, body: 'aaa' });
    const held = await lastHeld();
    queue.forward(held.key, { body: 'bbbbbb' });
    const echoed = JSON.parse((await p).body.toString());
    assert.equal(echoed.body, 'bbbbbb');
    assert.equal(echoed.headers['x-keep'], '1');
    assert.equal(echoed.headers['content-length'], '6');
  });

  it('edit URL ke host lain: Host header ikut menyesuaikan (kalau tidak disentuh user)', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/echo`);
    const held = await lastHeld();
    queue.forward(held.key, {
      url: `http://127.0.0.1:${target.httpPort}/echo?redirected=1`,
      headers: [...held.request.headers, ['X-Marker', '1']],
    });
    const echoed = JSON.parse((await p).body.toString());
    assert.equal(echoed.url, '/echo?redirected=1');
    assert.equal(echoed.host, `127.0.0.1:${target.httpPort}`);
  });

  it('Host header yang sengaja diubah user dipakai apa adanya (host header injection test)', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/echo`);
    const held = await lastHeld();
    queue.forward(held.key, {
      headers: held.request.headers.map(([k, v]) => (k.toLowerCase() === 'host' ? ([k, 'evil.example'] as [string, string]) : ([k, v] as [string, string]))),
    });
    const echoed = JSON.parse((await p).body.toString());
    assert.equal(echoed.host, 'evil.example');
  });

  it('drop (close): client dapat error koneksi, server tidak pernah menerima request, state = dropped', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    const settled = p.then(() => 'ok', () => 'err');
    const held = await lastHeld();
    queue.drop(held.key, 'close');
    assert.equal(await settled, 'err');
    assert.equal(target.seen.length, 0);
    const e = await exchangeWhere((x) => x.path === '/hello', 'dropped');
    assert.equal(e.state, 'dropped');
  });

  it('drop (respond): client menerima response buatan sendiri', async () => {
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    const held = await lastHeld();
    queue.drop(held.key, 'respond', { statusCode: 403, headers: [['x-blocked', 'by-proxykit']], body: 'blocked' });
    const r = await p;
    assert.equal(r.status, 403);
    assert.equal(r.body.toString(), 'blocked');
    assert.equal(r.headers['x-blocked'], 'by-proxykit');
    assert.equal(target.seen.length, 0);
  });

  it('beberapa request tertahan sekaligus dan bisa diputuskan tidak berurutan', async () => {
    queue.configure({ requests: true });
    const pA = viaProxy(port, `${HTTP()}/echo?n=A`);
    await waitFor(() => queue.size === 1, 3000, 'A held');
    const pB = viaProxy(port, `${HTTP()}/echo?n=B`);
    await waitFor(() => queue.size === 2, 3000, 'B held');
    const [a, b] = queue.list();
    assert.ok(a.request.url.endsWith('n=A') && b.request.url.endsWith('n=B'));
    queue.forward(b.key);
    assert.equal(JSON.parse((await pB).body.toString()).url, '/echo?n=B');
    assert.equal(queue.size, 1);
    queue.forward(a.key);
    assert.equal(JSON.parse((await pA).body.toString()).url, '/echo?n=A');
  });

  it('client putus saat ditahan: item otomatis dibuang dari queue, state = aborted', async () => {
    queue.configure({ requests: true });
    let clientReq: import('node:http').ClientRequest | undefined;
    const p = viaProxy(port, `${HTTP()}/hello`, { onRequest: (r) => (clientReq = r) });
    p.catch(() => {});
    await lastHeld();
    clientReq!.destroy();
    await waitFor(() => queue.size === 0, 5000, 'queue dibersihkan');
    const e = await exchangeWhere((x) => x.path === '/hello', 'aborted');
    assert.equal(e.state, 'aborted');
  });
});

describe('intercept: scope, timeout, toggle', () => {
  it('scope: hanya traffic yang match yang ditahan, sisanya lewat langsung', async () => {
    queue.configure({
      requests: true,
      scope: { include: [{ host: '^localhost$', path: '^/echo' }], exclude: [{ methods: ['DELETE'] }] },
    });
    // di luar scope (path beda) -> tidak ditahan
    const r1 = await viaProxy(port, `${HTTP()}/hello`);
    assert.equal(r1.status, 200);
    assert.equal(queue.size, 0);
    // dalam scope tapi method di-exclude -> tidak ditahan
    const r2 = await viaProxy(port, `${HTTP()}/echo`, { method: 'DELETE' });
    assert.equal(r2.status, 200);
    assert.equal(queue.size, 0);
    // dalam scope -> ditahan
    const p = viaProxy(port, `${HTTP()}/echo`);
    const held = await lastHeld();
    queue.forward(held.key);
    assert.equal((await p).status, 200);
  });

  it('timeout -> auto-forward', async () => {
    queue.configure({ requests: true, timeoutMs: 150, onTimeout: 'forward' });
    const r = await viaProxy(port, `${HTTP()}/hello`);
    assert.equal(r.status, 200);
    assert.equal(queue.size, 0);
  });

  it('timeout -> auto-drop', async () => {
    queue.configure({ requests: true, timeoutMs: 150, onTimeout: 'drop' });
    await assert.rejects(viaProxy(port, `${HTTP()}/hello`));
    assert.equal(target.seen.length, 0);
  });

  it('mematikan intercept melepas semua yang masih tertahan (forward)', async () => {
    queue.configure({ requests: true });
    const p1 = viaProxy(port, `${HTTP()}/hello`);
    const p2 = viaProxy(port, `${HTTP()}/hello?2`);
    await waitFor(() => queue.size === 2, 3000, '2 held');
    queue.configure({ requests: false });
    assert.equal((await p1).status, 200);
    assert.equal((await p2).status, 200);
    assert.equal(queue.size, 0);
  });

  it('forwardAll / dropAll', async () => {
    queue.configure({ requests: true });
    const ps = [1, 2, 3].map((i) => viaProxy(port, `${HTTP()}/hello?${i}`));
    await waitFor(() => queue.size === 3, 3000, '3 held');
    assert.equal(queue.forwardAll(), 3);
    for (const r of await Promise.all(ps)) assert.equal(r.status, 200);
  });

  it('event held / resolved terpancar untuk UI', async () => {
    const events: string[] = [];
    queue.on('held', (i) => events.push(`held:${i.kind}`));
    queue.on('resolved', (i) => events.push(`resolved:${i.kind}:${i.reason}`));
    queue.configure({ requests: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    queue.forward((await lastHeld()).key);
    await p;
    assert.deepEqual(events, ['held:request', 'resolved:request:user']);
  });
});

describe('intercept: response', () => {
  it('modify status, header, body -> client menerima versi edit; asli tersimpan', async () => {
    queue.configure({ responses: true });
    const p = viaProxy(port, `${HTTP()}/json`);
    const held = await lastHeld();
    assert.equal(held.kind, 'response');
    assert.equal(held.response!.statusCode, 200);
    assert.equal(held.response!.body.toString(), '{"role":"user","n":1}');
    assert.equal(held.request.url, `${HTTP()}/json`);

    // Alur UI yang realistis: user cuma edit body, header Content-Length lama (21) dibiarkan basi.
    assert.equal(getHeader(held.response!.headers, 'content-length'), '21');
    queue.forward(held.key, {
      statusCode: 202,
      headers: [...held.response!.headers, ['X-Tampered', '1']],
      body: '{"role":"admin","n":1}',
    });
    const r = await p;
    assert.equal(r.status, 202);
    assert.equal(r.headers['x-tampered'], '1');
    assert.equal(r.body.toString(), '{"role":"admin","n":1}');
    assert.equal(r.headers['content-length'], String('{"role":"admin","n":1}'.length));

    const e = await exchangeWhere((x) => x.path === '/json' && x.responseOriginal !== null, 'resp edit');
    assert.equal(e.modified, true);
    assert.equal(e.responseOriginal!.statusCode, 200);
    assert.equal(e.responseOriginal!.body.toString(), '{"role":"user","n":1}');
    // yang dicatat sebagai response utama = yang diterima client
    assert.equal(e.response!.statusCode, 202);
    assert.equal(e.response!.body.toString(), '{"role":"admin","n":1}');
  });

  it('response gzip: body yang ditampilkan sudah decoded, edit di-encode ulang otomatis sesuai Content-Encoding', async () => {
    queue.configure({ responses: true });
    const p = viaProxy(port, `${HTTP()}/gzip`);
    const held = await lastHeld();
    assert.equal(held.response!.body.toString(), 'compressed-original');
    queue.forward(held.key, { body: 'compressed-EDITED' });
    const r = await p;
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(r.body).toString(), 'compressed-EDITED');
  });

  it('forward tanpa edit: tidak dianggap modified', async () => {
    queue.configure({ responses: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    queue.forward((await lastHeld()).key);
    assert.equal((await p).body.toString(), 'hello-from-server');
    const e = await exchangeWhere((x) => x.path === '/hello', 'hello');
    assert.equal(e.modified, false);
  });

  it('drop response (close): client putus, server sebenarnya sudah menerima request', async () => {
    queue.configure({ responses: true });
    const p = viaProxy(port, `${HTTP()}/hello`);
    const settled = p.then(() => 'ok', () => 'err');
    queue.drop((await lastHeld()).key, 'close');
    assert.equal(await settled, 'err');
    assert.equal(target.seen.length, 1);
  });

  it('intercept request DAN response pada satu exchange', async () => {
    queue.configure({ requests: true, responses: true });
    const p = viaProxy(port, `${HTTPS()}/hello`, { ca: ca.cert });
    const req = await lastHeld();
    assert.equal(req.kind, 'request');
    queue.forward(req.key);
    const res = await waitFor(() => queue.list().find((i) => i.kind === 'response'), 5000, 'response held');
    assert.equal(res.exchangeId, req.exchangeId);
    queue.forward(res.key, { body: 'rewritten' });
    assert.equal((await p).body.toString(), 'rewritten');
  });
});

describe('WebSocket', () => {
  it('ws:// lewat proxy: handshake + pesan dua arah tercatat (text & binary)', async () => {
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
    const ws = new WebSocket(`ws://localhost:${target.httpPort}/ws`, { agent });
    const got: string[] = [];
    ws.on('message', (d, bin) => got.push(bin ? `bin:${(d as Buffer).toString('hex')}` : d.toString()));
    await new Promise<void>((res, rej) => (ws.on('open', res), ws.on('error', rej)));
    ws.send('ping');
    ws.send(Buffer.from([1, 2, 3]));
    await waitFor(() => got.length === 2, 5000, 'echo');
    assert.deepEqual(got, ['echo:ping', 'bin:010203']);
    ws.close(1000, 'bye');

    const e = await exchangeWhere((x) => x.protocol === 'ws' && x.state === 'closed', 'ws closed');
    assert.equal(e.status, 101);
    assert.equal(e.wsCloseCode, 1000);
    const msgs = store.listWs(e.id);
    assert.deepEqual(
      msgs.map((m) => [m.direction, m.isBinary, m.content.toString('hex')]),
      [
        ['c2s', false, Buffer.from('ping').toString('hex')],
        ['c2s', true, '010203'],
        ['s2c', false, Buffer.from('echo:ping').toString('hex')],
        ['s2c', true, '010203'],
      ].sort(() => 0) as any,
    );
  });

  it('wss:// (TLS didecrypt) lewat proxy dengan CA kita', async () => {
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
    const ws = new WebSocket(`wss://localhost:${target.httpsPort}/ws`, { agent, ca: ca.cert });
    const got: string[] = [];
    ws.on('message', (d) => got.push(d.toString()));
    await new Promise<void>((res, rej) => (ws.on('open', res), ws.on('error', rej)));
    ws.send('secret');
    await waitFor(() => got.length === 1, 5000, 'echo');
    assert.equal(got[0], 'echo:secret');
    ws.close();
    const e = await exchangeWhere((x) => x.protocol === 'wss', 'wss');
    await waitFor(() => store.listWs(e.id).length === 2, 5000, 'wss messages');
    assert.deepEqual(store.listWs(e.id).map((m) => m.content.toString()).sort(), ['echo:secret', 'secret']);
  });
});

describe('TLS passthrough (host dengan pinning)', () => {
  it('host di daftar passthrough tidak diintercept: client melihat cert asli target, tidak ada di history', async () => {
    await proxy.stop();
    proxy = new ProxyServer({ store, ca, queue, tlsPassthrough: ['localhost'], ignoreUpstreamCertErrors: true });
    ({ port } = await proxy.start(0));
    const r = await viaProxy(port, `${HTTPS()}/hello`, { ca: target.cert });
    assert.equal(r.status, 200);
    assert.equal(r.issuerCN, 'localhost', 'cert harus dari target, bukan dari ProxyKit CA');
    assert.equal(store.count(), 0);
  });
});

describe('persistence', () => {
  it('history SQLite bisa dibuka lagi setelah restart', async () => {
    const file = join(tmp(), 'history.db');
    const s1 = new Store(file);
    const px = new ProxyServer({ store: s1, ca });
    const { port: p } = await px.start(0);
    await viaProxy(p, `${HTTP()}/json`);
    await waitFor(() => s1.list()[0]?.status === 200, 5000, 'tersimpan');
    await px.stop();
    s1.close();

    const s2 = new Store(file);
    const [row] = s2.list();
    assert.equal(row.path, '/json');
    assert.equal(s2.get(row.id)!.response!.body.toString(), '{"role":"user","n":1}');
    s2.close();
  });
});
