import type { LogEntry, ProxyStatus } from '../../shared/api';
import { api } from '../api';
import { errMsg, fmtTime } from '../util';

interface Props {
  logs: LogEntry[];
  status: ProxyStatus | null;
  notify: (m: string, l?: 'info' | 'error') => void;
}

export function EventsView({ logs, status, notify }: Props) {
  const passthrough = status?.settings.tlsPassthrough ?? [];

  const addPassthrough = async (host: string) => {
    try {
      await api.updateSettings({ tlsPassthrough: [...passthrough, host] });
      notify(`${host} ditambahkan ke TLS passthrough (proxy di-restart)`);
    } catch (e) {
      notify(errMsg(e), 'error');
    }
  };

  // TLS error per host diringkas: biasanya satu app memicu puluhan handshake gagal.
  const tlsByHost = new Map<string, { count: number; last: number; cause: string }>();
  for (const l of logs) {
    if (l.kind !== 'tls-error') continue;
    const h = l.hostname ?? '(tanpa SNI)';
    const cur = tlsByHost.get(h);
    tlsByHost.set(h, { count: (cur?.count ?? 0) + 1, last: l.ts, cause: l.message });
  }

  return (
    <div className="view events">
      {tlsByHost.size > 0 && (
        <section>
          <h3>TLS handshake ditolak client</h3>
          <div className="muted">
            Penyebab umum: CA belum di-trust (Android 7+ butuh CA di system store atau network_security_config), atau app memakai
            certificate pinning. Tambahkan ke passthrough kalau host ini memang tidak perlu di-intercept.
          </div>
          <table className="grid compact">
            <thead>
              <tr>
                <th>Host</th>
                <th style={{ width: 70 }}>Jumlah</th>
                <th style={{ width: 110 }}>Terakhir</th>
                <th style={{ width: 160 }} />
              </tr>
            </thead>
            <tbody>
              {[...tlsByHost].map(([h, v]) => (
                <tr key={h}>
                  <td title={v.cause}>{h}</td>
                  <td className="num">{v.count}</td>
                  <td className="muted">{fmtTime(v.last)}</td>
                  <td>
                    {h !== '(tanpa SNI)' &&
                      (passthrough.includes(h) ? (
                        <span className="muted">sudah passthrough</span>
                      ) : (
                        <button onClick={() => addPassthrough(h)}>+ passthrough</button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="grow">
        <h3>Log</h3>
        <div className="log">
          {logs.length === 0 && <div className="muted">Belum ada event.</div>}
          {[...logs].reverse().map((l) => (
            <div key={l.id} className={`log-row ${l.level}`}>
              <span className="muted">{fmtTime(l.ts)}</span>
              <span className="tag">{l.kind}</span>
              <span>
                {l.hostname ? <b>{l.hostname} </b> : null}
                {l.message}
                {l.remoteIp ? <span className="muted"> · dari {l.remoteIp}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
