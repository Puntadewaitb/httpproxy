import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExchangeDTO, ExchangeSummary, ListFilter, RequestDTO, WsMessageDTO } from '../../shared/api';
import { toCurl } from '../../shared/rawhttp';
import { api } from '../api';
import { errMsg, fmtBytes, fmtMs, fmtTime, hexDump, statusClass } from '../util';
import { RequestView, ResponseView } from './MessageView';

interface Props {
  onSendToRepeater: (req: RequestDTO, parentId: string) => void;
  notify: (msg: string, level?: 'info' | 'error') => void;
}

type DetailTab = 'request' | 'response' | 'req-orig' | 'res-orig' | 'ws' | 'info';

export function HistoryView({ onSendToRepeater, notify }: Props) {
  const [q, setQ] = useState('');
  const [host, setHost] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [rows, setRows] = useState<ExchangeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExchangeDTO | null>(null);
  const [ws, setWs] = useState<WsMessageDTO[]>([]);
  const [tab, setTab] = useState<DetailTab>('request');
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const filter: ListFilter = {
    q: q || undefined,
    host: host || undefined,
    method: method || undefined,
    status: status ? Number(status) : undefined,
    source: (source || undefined) as ListFilter['source'],
    modifiedOnly: modifiedOnly || undefined,
    limit: 2000,
  };
  const filterKey = JSON.stringify(filter);

  const reload = useCallback(() => {
    api.listHistory(JSON.parse(filterKey)).then(setRows).catch((e) => notify(errMsg(e), 'error'));
  }, [filterKey, notify]);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api.getExchange(id);
    if (selectedRef.current !== id) return;
    setDetail(d);
    setWs(d && (d.protocol === 'ws' || d.protocol === 'wss') ? await api.listWs(id) : []);
  }, []);

  // Debounce filter teks supaya tidak query SQLite di setiap ketikan.
  useEffect(() => {
    const t = setTimeout(reload, 150);
    return () => clearTimeout(t);
  }, [reload]);

  useEffect(
    () =>
      api.onHistoryChanged((ids) => {
        reload();
        const sel = selectedRef.current;
        if (sel && (ids.length === 0 || ids.includes(sel))) void loadDetail(sel);
      }),
    [reload, loadDetail],
  );

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected);
  }, [selected, loadDetail]);

  useEffect(() => {
    if (!detail) return;
    const valid: DetailTab[] = ['request', 'info'];
    if (detail.response) valid.push('response');
    if (detail.requestOriginal) valid.push('req-orig');
    if (detail.responseOriginal) valid.push('res-orig');
    if (detail.protocol.startsWith('ws')) valid.push('ws');
    if (!valid.includes(tab)) setTab('request');
  }, [detail, tab]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      setSelected(next.id);
      document.getElementById(`row-${next.id}`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const clearAll = async () => {
    if (!confirm('Hapus semua history? Tidak bisa di-undo.')) return;
    await api.clearHistory();
    setSelected(null);
  };

  const exportHar = async () => {
    try {
      const p = await api.exportHar(JSON.parse(filterKey));
      if (p) notify(`HAR disimpan: ${p}`);
    } catch (e) {
      notify(errMsg(e), 'error');
    }
  };

  const copy = async (text: string, what: string) => {
    await api.copyText(text);
    notify(`${what} disalin`);
  };

  return (
    <div className="view history">
      <div className="filterbar">
        <input className="grow" placeholder="Cari di URL / body request / body response" value={q} onChange={(e) => setQ(e.target.value)} />
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 160 }} />
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">method</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">status</option>
          {[1, 2, 3, 4, 5].map((s) => (
            <option key={s} value={s}>
              {s}xx
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">source</option>
          <option value="proxy">proxy</option>
          <option value="repeater">repeater</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} /> modified
        </label>
        <span className="muted">{rows.length} baris</span>
        <button onClick={exportHar}>Export HAR</button>
        <button className="danger" onClick={clearAll}>
          Clear
        </button>
      </div>

      <div className="split">
        <div className="table-wrap" tabIndex={0} onKeyDown={onKey}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 56 }}>#</th>
                <th style={{ width: 100 }}>Time</th>
                <th style={{ width: 70 }}>Method</th>
                <th style={{ width: '22%' }}>Host</th>
                <th>Path</th>
                <th style={{ width: 56 }}>Status</th>
                <th style={{ width: 76 }}>Size</th>
                <th style={{ width: 70 }}>Dur</th>
                <th style={{ width: 92 }}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  id={`row-${r.id}`}
                  className={`${r.id === selected ? 'sel' : ''} st-${r.state}`}
                  onClick={() => setSelected(r.id)}
                >
                  <td className="muted">{r.seq}</td>
                  <td className="muted">{fmtTime(r.startedAt)}</td>
                  <td className="method">{r.method}</td>
                  <td className="ellipsis" title={r.host}>
                    {r.host}
                  </td>
                  <td className="ellipsis" title={r.path}>
                    {r.path}
                  </td>
                  <td className={statusClass(r.status)}>{r.status ?? (r.state === 'pending' ? '…' : '—')}</td>
                  <td className="num">{fmtBytes(r.respSize)}</td>
                  <td className="num">{fmtMs(r.durationMs)}</td>
                  <td>
                    {r.modified && <span className="tag mod">edit</span>}
                    {r.source === 'repeater' && <span className="tag rep">rep</span>}
                    {r.protocol.startsWith('ws') && <span className="tag ws">ws</span>}
                    {['dropped', 'aborted', 'error'].includes(r.state) && <span className="tag bad">{r.state}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty">
              Belum ada traffic. Set proxy client ke alamat di atas, lalu install CA (tombol <b>Export CA</b>) supaya HTTPS bisa di-intercept.
            </div>
          )}
        </div>

        <div className="detail">
          {!detail ? (
            <div className="empty">Pilih request di tabel.</div>
          ) : (
            <>
              <div className="detail-head">
                <div className="tabs small">
                  <button className={tab === 'request' ? 'on' : ''} onClick={() => setTab('request')}>
                    Request
                  </button>
                  {detail.response && (
                    <button className={tab === 'response' ? 'on' : ''} onClick={() => setTab('response')}>
                      Response
                    </button>
                  )}
                  {detail.requestOriginal && (
                    <button className={tab === 'req-orig' ? 'on' : ''} onClick={() => setTab('req-orig')}>
                      Req asli
                    </button>
                  )}
                  {detail.responseOriginal && (
                    <button className={tab === 'res-orig' ? 'on' : ''} onClick={() => setTab('res-orig')}>
                      Res asli
                    </button>
                  )}
                  {detail.protocol.startsWith('ws') && (
                    <button className={tab === 'ws' ? 'on' : ''} onClick={() => setTab('ws')}>
                      WS ({ws.length})
                    </button>
                  )}
                  <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>
                    Info
                  </button>
                </div>
                <div className="actions">
                  <button onClick={() => onSendToRepeater(detail.request, detail.id)}>→ Repeater</button>
                  <button onClick={() => copy(toCurl(detail.request), 'cURL')}>Copy cURL</button>
                  <button onClick={() => copy(detail.request.url, 'URL')}>Copy URL</button>
                </div>
              </div>
              <div className="detail-body">
                {tab === 'request' && <RequestView req={detail.request} />}
                {tab === 'response' && detail.response && <ResponseView res={detail.response} />}
                {tab === 'req-orig' && detail.requestOriginal && <RequestView req={detail.requestOriginal} />}
                {tab === 'res-orig' && detail.responseOriginal && <ResponseView res={detail.responseOriginal} />}
                {tab === 'ws' && <WsList messages={ws} />}
                {tab === 'info' && <Info d={detail} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WsList({ messages }: { messages: WsMessageDTO[] }) {
  if (!messages.length) return <div className="empty">Belum ada frame.</div>;
  return (
    <div className="ws-list">
      {messages.map((m) => (
        <div key={m.seq} className={`ws-msg ${m.direction}`}>
          <div className="muted">
            {m.direction === 'c2s' ? '→ client ke server' : '← server ke client'} · {fmtTime(m.ts)} · {fmtBytes(m.body.size)}
            {m.isBinary ? ' · binary' : ''}
          </div>
          <pre className="code">{m.body.text !== null && !m.isBinary ? m.body.text : hexDump(m.body.b64, 4096)}</pre>
        </div>
      ))}
    </div>
  );
}

function Info({ d }: { d: ExchangeDTO }) {
  const rows: [string, string][] = [
    ['ID', d.id],
    ['State', d.state],
    ['Source', d.source + (d.parentId ? ` (dari ${d.parentId})` : '')],
    ['Protocol', `${d.protocol} · HTTP/${d.httpVersion}`],
    ['Mulai', new Date(d.startedAt).toISOString()],
    ['Durasi', fmtMs(d.durationMs)],
    ['Request size', fmtBytes(d.reqSize)],
    ['Response size', fmtBytes(d.respSize)],
    ['Modified', d.modified ? 'ya (lihat tab "asli")' : 'tidak'],
  ];
  if (d.error) rows.push(['Error', d.error]);
  if (d.wsCloseCode !== null) rows.push(['WS close', `${d.wsCloseCode} ${d.wsCloseReason ?? ''}`]);
  return (
    <table className="headers">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="hk">{k}</td>
            <td className="hv">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
