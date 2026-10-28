import { useEffect, useMemo, useState } from 'react';
import type { CannedResponseDTO, HeldItemDTO, InterceptSettings, ProxyStatus } from '../../shared/api';
import { parseResponse, requestEditFrom, responseEditFrom, serializeRequest, serializeResponse } from '../../shared/rawhttp';
import { api } from '../api';
import { errMsg, fmtTime } from '../util';

interface Props {
  held: HeldItemDTO[];
  status: ProxyStatus | null;
  notify: (msg: string, level?: 'info' | 'error') => void;
}

const CANNED = 'HTTP/1.1 403 Forbidden\nContent-Type: text/plain\n\nBlocked by ProxyKit';

const initialText = (item: HeldItemDTO) =>
  item.kind === 'request' ? serializeRequest(item.request) : serializeResponse(item.response!, item.request.httpVersion);

export function InterceptView({ held, status, notify }: Props) {
  const [selKey, setSelKey] = useState<string | null>(null);
  const item = useMemo(() => held.find((h) => h.key === selKey) ?? held[0] ?? null, [held, selKey]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [updateCL, setUpdateCL] = useState(true);
  const [canned, setCanned] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const intercept: InterceptSettings | undefined = status?.settings.intercept;

  // Reset editor hanya saat item berganti (bukan setiap re-render list).
  useEffect(() => {
    setText(item ? initialText(item) : '');
    setError(null);
    setCanned(null);
  }, [item?.key]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const pickNext = () => {
    const i = held.findIndex((h) => h.key === item?.key);
    const next = held[i + 1] ?? held[i - 1] ?? null;
    setSelKey(next?.key ?? null);
  };

  const forward = async (withEdit: boolean) => {
    if (!item) return;
    try {
      const opts = { updateContentLength: updateCL };
      const edit = !withEdit
        ? undefined
        : item.kind === 'request'
          ? requestEditFrom(item.request, text, opts)
          : responseEditFrom(item.response!, text, opts);
      pickNext();
      const ok = await api.forward(item.key, edit);
      if (!ok) notify('Item sudah tidak ada di queue (timeout / client putus)', 'error');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const drop = async (mode: 'close' | 'reset') => {
    if (!item) return;
    pickNext();
    await api.drop(item.key, mode);
  };

  const respond = async () => {
    if (!item || canned === null) return;
    try {
      const p = parseResponse(canned);
      const resp: CannedResponseDTO = { statusCode: p.statusCode, headers: p.headers, body: p.body };
      pickNext();
      await api.drop(item.key, 'respond', resp);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void forward(true);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      void drop('close');
    }
  };

  const toggle = (patch: Partial<InterceptSettings>) => api.configureIntercept(patch).catch((e) => notify(errMsg(e), 'error'));
  const dirty = item ? text !== initialText(item) : false;

  return (
    <div className="view intercept" onKeyDown={onKey}>
      <div className="filterbar">
        <label className="check">
          <input type="checkbox" checked={!!intercept?.requests} onChange={(e) => toggle({ requests: e.target.checked })} /> Tahan request
        </label>
        <label className="check">
          <input type="checkbox" checked={!!intercept?.responses} onChange={(e) => toggle({ responses: e.target.checked })} /> Tahan response
        </label>
        <span className="muted">
          Scope: {intercept && intercept.scope.include.length + intercept.scope.exclude.length > 0
            ? `${intercept.scope.include.length} include, ${intercept.scope.exclude.length} exclude`
            : 'semua traffic'}
          {intercept?.timeoutMs ? ` · auto-${intercept.onTimeout} ${intercept.timeoutMs / 1000}s` : ''}
          {' '}(atur di Settings)
        </span>
        <span className="grow" />
        <span className="muted">{held.length} tertahan</span>
        <button disabled={!held.length} onClick={() => api.forwardAll()}>
          Forward all
        </button>
        <button className="danger" disabled={!held.length} onClick={() => api.dropAll()}>
          Drop all
        </button>
      </div>

      <div className="split">
        <div className="held-list">
          {held.length === 0 && (
            <div className="empty">
              {intercept?.requests || intercept?.responses
                ? 'Menunggu traffic yang masuk scope…'
                : 'Intercept mati. Centang "Tahan request" / "Tahan response" di atas.'}
            </div>
          )}
          {held.map((h) => (
            <div key={h.key} className={`held ${h.key === item?.key ? 'sel' : ''}`} onClick={() => setSelKey(h.key)}>
              <span className={`tag ${h.kind === 'request' ? 'req' : 'res'}`}>{h.kind === 'request' ? 'REQ' : 'RES'}</span>
              <span className="method">{h.request.method}</span>
              <span className="ellipsis grow" title={h.request.url}>
                {h.request.url}
              </span>
              <span className="muted">{Math.max(0, Math.round((now - h.heldAt) / 1000))}s</span>
            </div>
          ))}
        </div>

        <div className="detail">
          {!item ? (
            <div className="empty">Tidak ada item tertahan.</div>
          ) : (
            <>
              <div className="detail-head">
                <div className="muted ellipsis">
                  {item.kind === 'request' ? 'Request' : 'Response untuk'} <b>{item.request.method}</b> {item.request.url} · ditahan{' '}
                  {fmtTime(item.heldAt)}
                </div>
              </div>
              <textarea
                className="editor grow"
                spellCheck={false}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
              />
              {error && <div className="error-bar">{error}</div>}
              {canned !== null && (
                <div className="canned">
                  <div className="muted">Response buatan (dikirim ke client, request tidak diteruskan ke server):</div>
                  <textarea className="editor" spellCheck={false} rows={7} value={canned} onChange={(e) => setCanned(e.target.value)} />
                  <div className="row">
                    <button className="primary" onClick={respond}>
                      Kirim response ini
                    </button>
                    <button onClick={() => setCanned(null)}>Batal</button>
                  </div>
                </div>
              )}
              <div className="row actions-bar">
                <button className="primary" onClick={() => forward(true)} title="Ctrl+Enter">
                  {dirty ? 'Forward (edited)' : 'Forward'}
                </button>
                <button disabled={!dirty} onClick={() => setText(initialText(item))}>
                  Revert
                </button>
                <button className="danger" onClick={() => drop('close')} title="Ctrl+D">
                  Drop
                </button>
                <button className="danger" onClick={() => drop('reset')} title="TCP RST">
                  Reset
                </button>
                {item.kind === 'request' && <button onClick={() => setCanned(CANNED)}>Respond…</button>}
                <span className="grow" />
                <label className="check" title="Sesuaikan Content-Length kalau body diubah">
                  <input type="checkbox" checked={updateCL} onChange={(e) => setUpdateCL(e.target.checked)} /> Update Content-Length
                </label>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
