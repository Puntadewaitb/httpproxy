# @proxykit/desktop

UI Electron + React untuk `@proxykit/core`. Core jalan di **main process**; renderer hanya bicara lewat IPC (`window.proxykit`, lihat `src/shared/api.ts`).

```bash
# dari root repo
npm install
npm run desktop        # build core + desktop, lalu jalankan
npm run desktop:dev    # renderer via Vite dev server (hot reload UI); main/preload perlu restart manual
```

Env opsional: `PROXYKIT_DATA_DIR` (default `~/.proxykit`, **sama dengan CLI** supaya CA yang sudah di-trust di device tetap kepakai), `PROXYKIT_PORT` (override port setting, `0` = acak).

## Fitur

| Tab | Isi |
|---|---|
| **History** | Tabel live (batch 150 ms), filter teks (URL + body req/resp), host, method, status class, source, modified. Detail: headers, body pretty JSON / raw / hex, tab "Req/Res asli" kalau diedit, frame WebSocket. Aksi: → Repeater, Copy cURL, Copy URL, Export HAR, Clear. Navigasi ↑/↓. |
| **Intercept** | Queue item tertahan (request & response), editor raw HTTP. Forward / Forward (edited) `Ctrl+Enter`, Drop `Ctrl+D`, Reset (TCP RST), Respond… (response buatan, request tidak sampai server), Forward all / Drop all. Opsi **Update Content-Length** otomatis. |
| **Repeater** | Multi-tab, raw request (origin-form + Target, atau absolute URL), insecure TLS, timeout, auto Content-Length. `Ctrl+Enter` kirim. Tersimpan di history (`source=repeater`, `parentId`). |
| **Events** | TLS handshake yang ditolak client, diringkas per host + tombol **+ passthrough** (untuk app dengan pinning), log proxy/intercept. |
| **Settings** | Port, abaikan cert upstream, TLS passthrough, scope intercept (include/exclude regex host/path + method), auto-resolve timeout, info CA (path + SHA-256), Export CA `.crt`. |

`Ctrl+1..5` pindah tab. Topbar: status proxy (klik = start/stop), alamat 127.0.0.1 + LAN (buat setting proxy di device mobile), toggle Intercept, Export CA.

## Perilaku editor raw HTTP

- Edit dihitung minimal: hanya field yang berubah yang dikirim ke core, jadi forward tanpa perubahan tidak menandai exchange sebagai `modified`.
- Textarea menormalisasi CRLF ke LF; body yang hanya beda line ending **tidak** dianggap diubah.
- Body binary ditampilkan sebagai placeholder `<<binary body N bytes ...>>`. Biarkan utuh untuk mempertahankan body asli, atau ganti seluruhnya.
- Content-Length dihitung dalam byte UTF-8. Matikan "Update Content-Length" kalau sengaja mau tes CL mismatch (catatan: mockttp tetap bisa mengoreksi CL ke upstream; untuk kontrol penuh di wire pakai Repeater).

## Keamanan app

Renderer menampilkan traffic dari target (untrusted), jadi: `contextIsolation`, `sandbox`, tanpa `nodeIntegration`, CSP ketat tanpa inline script, body tidak pernah di-render sebagai HTML, navigasi & `window.open` diblok, semua permission request ditolak, IPC hanya diterima dari halaman app sendiri, regex scope divalidasi di main sebelum masuk core, intercept **selalu OFF** saat app start (walau setting terakhir ON). Proxy listen di semua interface (perlu untuk device mobile), jadi jalankan di jaringan yang kamu kontrol.

## Test

```bash
npm test -w @proxykit/desktop           # unit rawhttp + integrasi Engine (Node, tanpa Electron)
npm run build -w @proxykit/desktop && xvfb-run -a npm run test:e2e -w @proxykit/desktop   # E2E Electron asli via Playwright
```

E2E menyimpan screenshot di `e2e/screenshots/`.

## Belum ada

Packaging installer (electron-builder + signing), editor dengan syntax highlight (CodeMirror), match & replace rules, intercept frame WebSocket, setup device Android/iOS otomatis (adb / install CA ke system store).
