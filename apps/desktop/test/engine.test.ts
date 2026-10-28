import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { once } from 'node:events';
import type { HeldItemDTO } from '../src/shared/api';
import { requestEditFrom, responseEditFrom, serializeRequest, serializeResponse } from '../src/shared/rawhttp';
import { Engine, validateScope } from '../src/main/engine';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let target: http.Server;
let targetUrl: string;
const seen: Seen[] = [];
let dir: string;
let engine: Engine;
let proxyPort: number;

function viaProxy(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { host: '127.0.0.1', port: proxyPort, method, path: url, headers: { Host: u.host, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

const nextHeld = () => once(engine, 'held').then(([item]) => item as HeldItemDTO);

before(async () => {
  target = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(Buffer.from([0xff, 0x00, 0xfe]));
      }
      const payload = JSON.stringify({ role: 'user', method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'proxykit-desktop-'));
  engine = new Engine(dir, 0);
  const st = await engine.start();
  assert.ok(st.running, st.error ?? 'proxy tidak jalan');
  proxyPort = st.port!;
});

after(async () => {
  await engine.dispose();
  target.close();
});

describe('Engine', () => {
  it('status: CA dibuat, alamat 127.0.0.1 tercantum', async () => {
    const s = await engine.status();
    assert.match(s.caFingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(s.addresses[0] === `127.0.0.1:${proxyPort}`);
  });

  it('traffic tercatat dan event history-changed di-batch', async () => {
    const changed = once(engine, 'history-changed');
    const r = await viaProxy('GET', `${targetUrl}/hello?a=1`);
    assert.equal(r.status, 200);
    const [ids] = (await changed) as [string[]];
    assert.ok(ids.length >= 1);
    const row = engine.listHistory({ q: '/hello' })[0];
    assert.equal(row.method, 'GET');
    const d = engine.getExchange(row.id)!;
    assert.equal(d.response!.statusCode, 200);
    assert.equal(d.response!.body.text, r.body);
  });

  it('body binary dikirim sebagai b64 dengan text=null', async () => {
    await viaProxy('GET', `${targetUrl}/bin`);
    await once(engine, 'history-changed');
    const d = engine.getExchange(engine.listHistory({ q: '/bin' })[0].id)!;
    assert.equal(d.response!.body.text, null);
    assert.equal(Buffer.from(d.response!.body.b64, 'base64').toString('hex'), 'ff00fe');
  });

  it('intercept request: edit dari teks editor sampai ke server, history = versi terkirim', async () => {
    await engine.configureIntercept({ requests: true, scope: { include: [{ path: '^/admin' }], exclude: [] } });
    const heldP = nextHeld();
    const resP = viaProxy('POST', `${targetUrl}/admin?x=1`, '{"isAdmin":false}', { 'Content-Type': 'application/json' });
    const item = await heldP;
    assert.equal(item.kind, 'request');
    const text = serializeRequest(item.request).replace('"isAdmin":false', '"isAdmin":true');
    const edit = requestEditFrom(item.request, text);
    assert.ok(engine.forward(item.key, edit));
    const res = await resP;
    assert.equal(res.status, 200);
    const last = seen.at(-1)!;
    assert.equal(last.body, '{"isAdmin":true}');
    assert.equal(last.headers['content-length'], String('{"isAdmin":true}'.length));
    await once(engine, 'history-changed');
    const d = engine.getExchange(item.exchangeId)!;
    assert.ok(d.modified);
    assert.equal(d.request.body.text, '{"isAdmin":true}');
    assert.equal(d.requestOriginal!.body.text, '{"isAdmin":false}');
  });

  it('request di luar scope tidak ditahan', async () => {
    const r = await viaProxy('GET', `${targetUrl}/public`);
    assert.equal(r.status, 200);
    assert.equal(engine.listHeld().length, 0);
  });

  it('drop respond: client dapat response buatan, server tidak menerima request', async () => {
    const before = seen.length;
    const heldP = nextHeld();
    const resP = viaProxy('GET', `${targetUrl}/admin/delete`);
    const item = await heldP;
    engine.drop(item.key, 'respond', { statusCode: 403, headers: [['X-Blocked', '1']], body: 'nope' });
    const res = await resP;
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-blocked'], '1');
    assert.equal(res.body, 'nope');
    assert.equal(seen.length, before);
    await engine.configureIntercept({ requests: false });
  });

  it('intercept response: edit body, Content-Length disesuaikan', async () => {
    await engine.configureIntercept({ responses: true, scope: { include: [{ path: '^/me' }], exclude: [] } });
    const heldP = nextHeld();
    const resP = viaProxy('GET', `${targetUrl}/me`);
    const item = await heldP;
    assert.equal(item.kind, 'response');
    const text = serializeResponse(item.response!).replace('"role":"user"', '"role":"administrator"');
    engine.forward(item.key, responseEditFrom(item.response!, text));
    const res = await resP;
    assert.match(res.body, /"role":"administrator"/);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)));
    await engine.configureIntercept({ responses: false });
  });

  it('scope dengan regex invalid ditolak (tidak sampai ke core)', async () => {
    await assert.rejects(engine.configureIntercept({ scope: { include: [{ host: '([' }], exclude: [] } }), /regex host tidak valid/);
    assert.throws(() => validateScope({ include: [], exclude: [{ path: '*' }] }), /exclude #1/);
  });

  it('repeater tersimpan dengan parentId', async () => {
    const parent = engine.listHistory({ q: '/hello' })[0];
    const r = await engine.sendRepeater(
      { method: 'PUT', url: `${targetUrl}/rep`, headers: [['X-Test', 'Yes']], body: 'abc', insecure: false, timeoutMs: 5000 },
      parent.id,
    );
    assert.equal(r.response!.statusCode, 200);
    assert.equal(seen.at(-1)!.headers['x-test'], 'Yes');
    const d = engine.getExchange(r.id)!;
    assert.equal(d.source, 'repeater');
    assert.equal(d.parentId, parent.id);
  });

  it('settings dipersist, intercept tidak pernah aktif otomatis saat start ulang', async () => {
    await engine.configureIntercept({ requests: true, timeoutMs: 5000 });
    const saved = JSON.parse(readFileSync(join(dir, 'desktop-settings.json'), 'utf8'));
    assert.equal(saved.intercept.requests, true);
    const e2dir = mkdtempSync(join(tmpdir(), 'proxykit-desktop-'));
    writeFileSync(join(e2dir, 'desktop-settings.json'), JSON.stringify(saved));
    const e2 = new Engine(e2dir, 0);
    const s2 = await e2.status();
    assert.equal(s2.settings.intercept.requests, false);
    assert.equal(s2.settings.intercept.timeoutMs, 5000);
    await e2.dispose();
    await engine.configureIntercept({ requests: false, timeoutMs: 0 });
  });

  it('first run: data dir belum ada -> dibuat otomatis (bukan crash sebelum window)', async () => {
    const fresh = join(mkdtempSync(join(tmpdir(), 'proxykit-desktop-')), 'belum', 'ada', '.proxykit');
    assert.equal(existsSync(fresh), false);
    const e3 = new Engine(fresh, 0);
    const s3 = await e3.start();
    assert.ok(s3.running, s3.error ?? 'proxy tidak jalan');
    assert.ok(existsSync(join(fresh, 'history.db')));
    assert.ok(existsSync(join(fresh, 'ca-cert.pem')));
    await e3.dispose();
  });

  it('ganti port -> proxy restart di port baru', async () => {
    const s = await engine.updateSettings({ port: 0 });
    assert.ok(s.running);
    proxyPort = s.port!;
    assert.equal((await viaProxy('GET', `${targetUrl}/after-restart`)).status, 200);
    await assert.rejects(engine.updateSettings({ port: 70000 }), /Port/);
  });

  it('HAR export valid JSON berisi entry', () => {
    const har = JSON.parse(engine.har({}));
    assert.ok(har.log.entries.length >= 5);
  });
});
