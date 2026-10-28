// Smoke test E2E: jalankan app Electron asli, kirim traffic lewat proxy, uji History / Intercept / Repeater.
// Pakai: npm run build && node e2e/smoke.mjs   (Linux tanpa display: xvfb-run -a node e2e/smoke.mjs)
// Uji binary hasil packaging: APP_EXECUTABLE=release/linux-unpacked/proxykit node e2e/smoke.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const shots = process.env.SHOTS_DIR ?? join(appDir, 'e2e', 'screenshots');
mkdirSync(shots, { recursive: true });
const electronBin = createRequire(join(appDir, 'package.json'))('electron');

const seen = [];
const target = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const payload = JSON.stringify({ ok: true, role: 'user', path: req.url, received: body });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Server': 'target' });
    res.end(payload);
  });
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const tport = target.address().port;
const T = `http://127.0.0.1:${tport}`;

const app = await electron.launch({
  executablePath: process.env.APP_EXECUTABLE ?? electronBin,
  args: process.env.APP_EXECUTABLE ? ['--no-sandbox'] : ['--no-sandbox', appDir],
  env: { ...process.env, PROXYKIT_DATA_DIR: mkdtempSync(join(tmpdir(), 'proxykit-e2e-')), PROXYKIT_PORT: '0' },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setViewportSize({ width: 1440, height: 860 });

let proxyPort;
function viaProxy(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: proxyPort, method, path: T + path, headers: { Host: `127.0.0.1:${tport}`, ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

try {
  // ---- Hardening renderer ----
  const isolated = await page.evaluate(() => ({ req: typeof require, proc: typeof process, api: typeof window.proxykit?.status }));
  assert.deepEqual(isolated, { req: 'undefined', proc: 'undefined', api: 'function' }, 'renderer harus terisolasi dari Node');

  await page.locator('.pill.ok').waitFor({ timeout: 15000 });
  proxyPort = (await page.evaluate(() => window.proxykit.status())).port;
  console.log('proxy port', proxyPort);

  // ---- History ----
  await viaProxy('GET', '/api/v1/profile?id=42', undefined, { Authorization: 'Bearer user-token', Accept: 'application/json' });
  await viaProxy('POST', '/api/v1/login', '{"username":"yogi","password":"hunter2"}', { 'Content-Type': 'application/json' });
  await viaProxy('GET', '/static/app.js');
  await page.locator('table.grid tbody tr', { hasText: '/api/v1/login' }).waitFor();
  await page.locator('table.grid tbody tr', { hasText: '/api/v1/profile' }).click();
  await page.locator('.detail .startline', { hasText: '/api/v1/profile?id=42' }).waitFor();
  await page.locator('.detail-head button', { hasText: 'Response' }).click();
  await page.locator('.detail pre.code', { hasText: '"role": "user"' }).waitFor(); // pretty JSON
  await page.screenshot({ path: join(shots, '1-history.png') });

  // Filter teks
  await page.fill('.history .filterbar input.grow', 'hunter2');
  await page.waitForFunction(() => document.querySelectorAll('.history table.grid tbody tr').length === 1);
  await page.fill('.history .filterbar input.grow', '');

  // ---- Intercept: tahan, edit, forward ----
  await page.locator('.topbar button', { hasText: 'Intercept OFF' }).click();
  await page.locator('.intercept').waitFor();
  const pending = viaProxy('POST', '/api/v1/users/42', '{"isAdmin":false}', { 'Content-Type': 'application/json' });
  await page.locator('.held', { hasText: '/api/v1/users/42' }).waitFor();
  const badge = await page.locator('nav.tabs .badge.warn').textContent();
  assert.equal(badge, '1');
  const editor = page.locator('.intercept textarea.editor').first();
  const text = await editor.inputValue();
  assert.match(text, /^POST http:\/\/127\.0\.0\.1:\d+\/api\/v1\/users\/42 HTTP\/1\.1/);
  await editor.fill(text.replace('"isAdmin":false', '"isAdmin":true').replace('POST ', 'PUT '));
  await page.screenshot({ path: join(shots, '2-intercept.png') });
  await page.locator('.intercept button', { hasText: 'Forward (edited)' }).click();
  const r = await pending;
  assert.equal(r.status, 200);
  const last = seen.at(-1);
  assert.equal(last.method, 'PUT');
  assert.equal(last.body, '{"isAdmin":true}');
  assert.equal(last.headers['content-length'], '16');
  await page.locator('.held').waitFor({ state: 'detached' });

  // Drop via shortcut Ctrl+D
  const before = seen.length;
  const dropped = viaProxy('GET', '/api/v1/delete-all').catch((e) => ({ error: e.code }));
  await page.locator('.held', { hasText: '/api/v1/delete-all' }).waitFor();
  await page.locator('.intercept textarea.editor').first().press('Control+d');
  const dr = await dropped;
  assert.ok(dr.error || dr.status === undefined, 'client harus putus');
  assert.equal(seen.length, before, 'server tidak boleh menerima request yang di-drop');

  await page.locator('.topbar button', { hasText: 'Intercept ON' }).click();

  // ---- History menandai edit ----
  await page.locator('nav.tabs button', { hasText: 'History' }).click();
  const editedRow = page.locator('table.grid tbody tr', { hasText: '/api/v1/users/42' });
  await editedRow.locator('.tag.mod').waitFor();
  await editedRow.click();
  await page.locator('.detail-head button', { hasText: 'Req asli' }).click();
  await page.locator('.detail pre.code', { hasText: '"isAdmin": false' }).waitFor();

  // ---- Repeater ----
  await page.locator('table.grid tbody tr', { hasText: '/api/v1/profile' }).click();
  await page.locator('.detail-head button', { hasText: '→ Repeater' }).click();
  const rep = page.locator('.repeater textarea.editor');
  const rtext = await rep.inputValue();
  assert.match(rtext, /^GET \/api\/v1\/profile\?id=42 HTTP\/1\.1/);
  await rep.fill(rtext.replace('id=42', 'id=43').replace('Bearer user-token', 'Bearer other-user'));
  await page.locator('.repeater button', { hasText: 'Send' }).click();
  await page.locator('.repeater .detail-body pre.code', { hasText: '/api/v1/profile?id=43' }).waitFor();
  assert.equal(seen.at(-1).headers.authorization, 'Bearer other-user');
  await page.screenshot({ path: join(shots, '3-repeater.png') });

  // ---- Settings: regex scope invalid tidak bisa disimpan ----
  await page.locator('nav.tabs button', { hasText: 'Settings' }).click();
  await page.locator('.rules', { hasText: 'Include' }).locator('button', { hasText: '+ rule' }).click();
  await page.locator('.rules', { hasText: 'Include' }).locator('input').first().fill('([');
  assert.ok(await page.locator('button', { hasText: 'Simpan scope' }).isDisabled());
  await page.locator('.rules', { hasText: 'Include' }).locator('input').first().fill('^127\\.0\\.0\\.1$');
  await page.locator('button', { hasText: 'Simpan scope' }).click();
  await page.locator('.toast', { hasText: 'Scope & intercept disimpan' }).waitFor();
  await page.screenshot({ path: join(shots, '4-settings.png') });

  // ---- Navigasi keluar diblok ----
  await page.evaluate(() => (location.href = 'https://example.com'));
  await page.waitForTimeout(500);
  assert.ok(page.url().startsWith('file://'), `navigasi harus diblok, url sekarang ${page.url()}`);

  assert.deepEqual(errors, [], 'tidak boleh ada error di console renderer');
  console.log('E2E OK');
} finally {
  await app.close();
  target.close();
}
