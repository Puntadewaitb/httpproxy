# ProxyKit

MITM proxy buat VAPT (mirip HTTP Toolkit / Burp Proxy): core headless + UI desktop Electron.

```
packages/core   @proxykit/core: proxy, CA, intercept queue, repeater, SQLite history, HAR (dipakai CLI & desktop)
apps/desktop    @proxykit/desktop: Electron + React (History, Intercept, Repeater, Events, Settings)
```

Stack: Node 22.13+, TypeScript, [mockttp](https://github.com/httptoolkit/mockttp) (Apache-2.0), `node:sqlite` (built-in, tanpa native module), ws.

## Quickstart

```bash
npm install
npm test            # core: 50 test end-to-end (HTTP, HTTPS MITM, WebSocket, intercept, repeater, HAR) + desktop: 31
npm run build
node packages/core/dist/cli.js --port 8080 --har out.har   # CLI, Ctrl+C untuk export HAR
npm run desktop     # UI desktop (build + jalankan Electron)
```

Detail UI desktop: [`apps/desktop/README.md`](apps/desktop/README.md).

CLI menyimpan CA + `history.db` di `~/.proxykit` (ubah dengan `--data-dir`). Opsi lain: `--insecure` (abaikan cert upstream self-signed), `--tls-passthrough "*.apple.com"` (jangan intercept host tertentu, mis. yang pakai pinning).

CA **dibuat unik per instalasi** saat first run; `ca-key.pem` permission `0600`. Jangan dibagikan: siapa pun yang punya key bisa MITM device yang trust CA-nya.

## Pakai sebagai library

```ts
import { ProxyServer, InterceptQueue, Store, Repeater, exportHar, loadOrCreateCA } from '@proxykit/core';

const ca = await loadOrCreateCA('~/.proxykit');
const store = new Store('history.db');
const queue = new InterceptQueue();
const proxy = new ProxyServer({ store, ca, queue, ignoreUpstreamCertErrors: true });
await proxy.start(8080);

// Intercept request ke api.target.com saja, auto-forward setelah 30 detik
queue.configure({
  requests: true,
  scope: { include: [{ host: '^api\\.target\\.com$' }], exclude: [] },
  timeoutMs: 30_000, onTimeout: 'forward',
});

queue.on('held', (item) => {
  // UI menampilkan item.request (method, url, headers[], body), lalu salah satu:
  queue.forward(item.key);                                  // lanjut apa adanya
  queue.forward(item.key, { method: 'PUT', body: '{"isAdmin":true}' }); // modify + forward
  queue.drop(item.key, 'close');                            // atau 'reset' / 'respond' (+ response buatan)
});

// Response juga bisa ditahan/diedit: queue.configure({ responses: true })
// Repeater: kirim ulang langsung ke target (tanpa proxy), tersimpan di history
const r = await new Repeater(store).send({ method: 'POST', url: 'https://api.target.com/v1/x', headers: [['X-A', '1']], body: '{}', insecure: true });
// HAR 1.2
const har = exportHar(store, { host: 'target.com' });
```

Event untuk UI: `proxy.on('exchange' | 'tls-error' | 'client-error')`, `queue.on('held' | 'resolved')`.

## Perilaku penting

- Request/response yang diedit: kolom utama di history = versi yang **benar-benar dikirim**, versi asli di `requestOriginal` / `responseOriginal`; `modified: true`.
- Body selalu disimpan **decoded** (gzip/br/deflate). Kalau body response diedit, mockttp meng-encode ulang sesuai `Content-Encoding` dan memperbarui `Content-Length`.
- Edit URL ke host lain: header `Host` ikut menyesuaikan **kecuali** kamu sendiri mengubah `Host` (berguna untuk tes Host header injection).
- Client putus saat request tertahan: item otomatis dibuang dari queue, state `aborted`.
- `tls-error` terpancar saat client menolak sertifikat proxy: tanda CA belum trusted atau app memakai pinning.

## Batasan yang sudah diketahui (terverifikasi di test)

- **Casing header ke upstream**: mockttp me-lowercase nama header saat meneruskan request (history tetap menyimpan casing asli). Kalau butuh kontrol casing/urutan/duplikat header persis di wire, pakai **Repeater** (raw header).
- **WebSocket**: capture dua arah (text/binary) + close code; frame belum bisa di-intercept/edit.
- **HTTP/2**: belum diuji di sini (semua test HTTP/1.1).
- Repeater tidak decode `zstd` (dikembalikan apa adanya).
- Belum ada: packaging installer desktop (electron-builder), setup device Android/iOS (adb, install CA ke system store), Frida untuk bypass pinning, match-and-replace otomatis. Semuanya butuh mesin dengan display/device.
- Node 22.x mencetak `ExperimentalWarning: SQLite` sekali saat start (node:sqlite masih experimental di 22; di Electron/Node 24 tidak).
- `npm audit` melaporkan advisory `basic-ftp` (transitive: mockttp → pac-proxy-agent → get-uri). Hanya terjangkau kalau PAC di-fetch via FTP; tidak relevan untuk pemakaian proxy lokal ini.
