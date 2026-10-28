#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exportHar, loadOrCreateCA, ProxyServer, Store } from './index.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8080' },
    'data-dir': { type: 'string', default: join(homedir(), '.proxykit') },
    'tls-passthrough': { type: 'string', multiple: true },
    insecure: { type: 'boolean', default: false },
    har: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`proxykit - MITM proxy headless

  --port <n>                 port listen (default 8080, 0 = acak)
  --data-dir <dir>           lokasi CA + history.db (default ~/.proxykit)
  --tls-passthrough <host>   host yang TLS-nya tidak diintercept (boleh diulang, wildcard: *.example.com)
  --insecure                 abaikan error sertifikat upstream (target self-signed)
  --har <file>               export history ke HAR saat Ctrl+C`);
  process.exit(0);
}

const dir = resolve(values['data-dir']!);
const ca = await loadOrCreateCA(dir);
const store = new Store(join(dir, 'history.db'));
const proxy = new ProxyServer({
  store,
  ca,
  tlsPassthrough: values['tls-passthrough'],
  ignoreUpstreamCertErrors: values.insecure,
});

const { port } = await proxy.start(Number(values.port));
console.log(`Proxy   : http://127.0.0.1:${port}`);
console.log(`CA cert : ${ca.certPath}${ca.created ? '  (baru dibuat)' : ''}`);
console.log(`SHA-256 : ${ca.fingerprint}`);
console.log(`History : ${join(dir, 'history.db')}\n`);

proxy.on('exchange', ({ id, phase }) => {
  if (phase !== 'response') return;
  const e = store.get(id);
  if (e) console.log(`${String(e.status ?? '---').padEnd(3)} ${e.method.padEnd(7)} ${e.url}${e.modified ? '  [modified]' : ''}`);
});
proxy.on('tls-error', (e) => console.warn(`TLS error ${e.hostname ?? '?'}: ${e.cause} (CA belum trusted di client, atau app pakai pinning)`));
proxy.on('client-error', (e) => console.warn(`error: ${e.message}`));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  if (values.har) {
    writeFileSync(values.har, JSON.stringify(exportHar(store), null, 2));
    console.log(`\nHAR ditulis: ${values.har}`);
  }
  await proxy.stop();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
