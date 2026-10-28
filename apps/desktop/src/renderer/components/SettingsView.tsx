import { useEffect, useState } from 'react';
import type { ProxyStatus, Scope } from '../../shared/api';
import { api } from '../api';
import { errMsg } from '../util';

interface RuleRow {
  host: string;
  path: string;
  methods: string;
}

const toRows = (rules: Scope['include']): RuleRow[] =>
  rules.map((r) => ({ host: r.host ?? '', path: r.path ?? '', methods: (r.methods ?? []).join(', ') }));

const fromRows = (rows: RuleRow[]): Scope['include'] =>
  rows
    .filter((r) => r.host.trim() || r.path.trim() || r.methods.trim())
    .map((r) => {
      const methods = r.methods.split(/[\s,]+/).filter(Boolean).map((m) => m.toUpperCase());
      return {
        ...(r.host.trim() ? { host: r.host.trim() } : {}),
        ...(r.path.trim() ? { path: r.path.trim() } : {}),
        ...(methods.length ? { methods } : {}),
      };
    });

function regexError(v: string): string | null {
  if (!v.trim()) return null;
  try {
    new RegExp(v);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function RuleEditor({ title, rows, setRows }: { title: string; rows: RuleRow[]; setRows: (r: RuleRow[]) => void }) {
  const set = (i: number, patch: Partial<RuleRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="rules">
      <div className="rules-head">
        <b>{title}</b>
        <button onClick={() => setRows([...rows, { host: '', path: '', methods: '' }])}>+ rule</button>
      </div>
      {rows.length === 0 && <div className="muted">(kosong)</div>}
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <input
            className={`grow ${regexError(r.host) ? 'invalid' : ''}`}
            placeholder="host regex, mis. ^api\.target\.com$"
            value={r.host}
            title={regexError(r.host) ?? ''}
            onChange={(e) => set(i, { host: e.target.value })}
          />
          <input
            className={`grow ${regexError(r.path) ? 'invalid' : ''}`}
            placeholder="path regex, mis. ^/v1/"
            value={r.path}
            title={regexError(r.path) ?? ''}
            onChange={(e) => set(i, { path: e.target.value })}
          />
          <input style={{ width: 140 }} placeholder="GET, POST" value={r.methods} onChange={(e) => set(i, { methods: e.target.value })} />
          <button className="danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function SettingsView({ status, notify }: { status: ProxyStatus | null; notify: (m: string, l?: 'info' | 'error') => void }) {
  const s = status?.settings;
  const [port, setPort] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [passthrough, setPassthrough] = useState('');
  const [include, setInclude] = useState<RuleRow[]>([]);
  const [exclude, setExclude] = useState<RuleRow[]>([]);
  const [timeoutS, setTimeoutS] = useState('0');
  const [onTimeout, setOnTimeout] = useState<'forward' | 'drop'>('forward');
  const loadedKey = s ? JSON.stringify(s) : '';

  // Sinkron dari main saat setting berubah (mis. passthrough ditambah dari tab Events).
  useEffect(() => {
    if (!s) return;
    setPort(String(s.port));
    setInsecure(s.ignoreUpstreamCertErrors);
    setPassthrough(s.tlsPassthrough.join('\n'));
    setInclude(toRows(s.intercept.scope.include));
    setExclude(toRows(s.intercept.scope.exclude));
    setTimeoutS(String(s.intercept.timeoutMs / 1000));
    setOnTimeout(s.intercept.onTimeout);
  }, [loadedKey]);

  const saveProxy = async () => {
    try {
      const st = await api.updateSettings({
        port: Number(port),
        ignoreUpstreamCertErrors: insecure,
        tlsPassthrough: passthrough.split(/\r?\n/),
      });
      notify(st.error ? `Proxy error: ${st.error}` : 'Setting proxy disimpan', st.error ? 'error' : 'info');
    } catch (e) {
      notify(errMsg(e), 'error');
    }
  };

  const saveIntercept = async () => {
    try {
      await api.configureIntercept({
        scope: { include: fromRows(include), exclude: fromRows(exclude) },
        timeoutMs: Math.max(0, Number(timeoutS) || 0) * 1000,
        onTimeout,
      });
      notify('Scope & intercept disimpan');
    } catch (e) {
      notify(errMsg(e), 'error');
    }
  };

  const exportCA = async () => {
    try {
      const p = await api.exportCA();
      if (p) notify(`CA disimpan: ${p}`);
    } catch (e) {
      notify(errMsg(e), 'error');
    }
  };

  const scopeInvalid = [...include, ...exclude].some((r) => regexError(r.host) || regexError(r.path));

  return (
    <div className="view settings">
      <section>
        <h3>Proxy</h3>
        <div className="form">
          <label>Port</label>
          <input type="number" min={0} max={65535} value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 120 }} />
          <label>Upstream TLS</label>
          <label className="check">
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Abaikan error sertifikat target
            (self-signed / lab)
          </label>
          <label>TLS passthrough</label>
          <div>
            <textarea
              className="editor"
              rows={4}
              spellCheck={false}
              placeholder={'*.apple.com\npinned.bank.co.id'}
              value={passthrough}
              onChange={(e) => setPassthrough(e.target.value)}
            />
            <div className="muted">Satu host per baris (wildcard boleh). Host ini tidak di-MITM: berguna untuk app yang pakai pinning.</div>
          </div>
        </div>
        <button className="primary" onClick={saveProxy}>
          Simpan & restart proxy
        </button>
      </section>

      <section>
        <h3>Intercept scope</h3>
        <div className="muted">
          Regex, case-insensitive untuk host. Exclude selalu menang; include kosong = semua traffic. Scope ini hanya untuk intercept,
          history tetap mencatat semua.
        </div>
        <RuleEditor title="Include" rows={include} setRows={setInclude} />
        <RuleEditor title="Exclude" rows={exclude} setRows={setExclude} />
        <div className="form">
          <label>Auto-resolve</label>
          <div className="row">
            <input type="number" min={0} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} style={{ width: 90 }} />
            <span className="muted">detik (0 = tunggu selamanya), lalu</span>
            <select value={onTimeout} onChange={(e) => setOnTimeout(e.target.value as 'forward' | 'drop')}>
              <option value="forward">forward</option>
              <option value="drop">drop</option>
            </select>
          </div>
        </div>
        <button className="primary" disabled={scopeInvalid} onClick={saveIntercept}>
          Simpan scope
        </button>
      </section>

      <section>
        <h3>CA & data</h3>
        <div className="form">
          <label>CA cert</label>
          <code>{status?.caCertPath ?? '-'}</code>
          <label>SHA-256</label>
          <code className="wrap">{status?.caFingerprint ?? '-'}</code>
          <label>Data dir</label>
          <code>{status?.dataDir}</code>
        </div>
        <div className="row">
          <button onClick={exportCA}>Export CA (.crt)</button>
          <button onClick={() => api.openDataDir()}>Buka folder data</button>
        </div>
        <div className="muted">
          CA unik per instalasi. Jangan bagikan <code>ca-key.pem</code>: siapa pun yang memegangnya bisa MITM device yang trust CA ini.
          Cocokkan SHA-256 di atas dengan cert yang terpasang di device.
        </div>
      </section>
    </div>
  );
}
