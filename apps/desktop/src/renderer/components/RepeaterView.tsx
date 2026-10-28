import type { RepeaterResultDTO, RequestDTO } from '../../shared/api';
import { originOf, repeaterRequestFrom, serializeRequest } from '../../shared/rawhttp';
import { api } from '../api';
import { errMsg, fmtBytes, fmtMs, statusClass } from '../util';
import { ResponseView } from './MessageView';

export interface RepeaterTab {
  id: number;
  name: string;
  target: string;
  text: string;
  insecure: boolean;
  updateContentLength: boolean;
  timeoutMs: number;
  parentId?: string;
  sending: boolean;
  error: string | null;
  result: RepeaterResultDTO | null;
}

let nextId = 1;

export function newRepeaterTab(req?: RequestDTO, parentId?: string): RepeaterTab {
  const id = nextId++;
  let name = `#${id}`;
  if (req) {
    try {
      const u = new URL(req.url);
      name = `${req.method} ${u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname}`;
    } catch {
      /* default */
    }
  }
  return {
    id,
    name,
    target: req ? originOf(req.url) : 'https://example.com',
    text: req ? serializeRequest(req, 'origin') : 'GET / HTTP/1.1\nHost: example.com\nUser-Agent: ProxyKit\nAccept: */*\n\n',
    insecure: true,
    updateContentLength: true,
    timeoutMs: 30_000,
    parentId,
    sending: false,
    error: null,
    result: null,
  };
}

interface Props {
  tabs: RepeaterTab[];
  activeId: number | null;
  setActive: (id: number) => void;
  update: (id: number, patch: Partial<RepeaterTab>) => void;
  add: () => void;
  close: (id: number) => void;
}

export function RepeaterView({ tabs, activeId, setActive, update, add, close }: Props) {
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const send = async () => {
    if (!tab || tab.sending) return;
    let req;
    try {
      req = repeaterRequestFrom(tab.target, tab.text, { updateContentLength: tab.updateContentLength });
    } catch (e) {
      update(tab.id, { error: errMsg(e) });
      return;
    }
    update(tab.id, { sending: true, error: null });
    try {
      const result = await api.sendRepeater({ ...req, insecure: tab.insecure, timeoutMs: tab.timeoutMs }, tab.parentId);
      update(tab.id, { sending: false, result, error: result.error ?? null });
    } catch (e) {
      update(tab.id, { sending: false, error: errMsg(e) });
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="view repeater" onKeyDown={onKey}>
      <div className="tabs small rep-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={t.id === tab?.id ? 'on' : ''} onClick={() => setActive(t.id)}>
            {t.name}
            <span
              className="x"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button onClick={add} title="Tab baru">
          +
        </button>
      </div>

      {!tab ? (
        <div className="empty">Klik + atau kirim request dari History (→ Repeater).</div>
      ) : (
        <>
          <div className="filterbar">
            <span className="muted">Target</span>
            <input
              className="grow"
              value={tab.target}
              onChange={(e) => update(tab.id, { target: e.target.value })}
              placeholder="https://api.target.com (dipakai kalau request line origin-form)"
            />
            <label className="check" title="Abaikan error sertifikat target">
              <input type="checkbox" checked={tab.insecure} onChange={(e) => update(tab.id, { insecure: e.target.checked })} /> insecure TLS
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={tab.updateContentLength}
                onChange={(e) => update(tab.id, { updateContentLength: e.target.checked })}
              />{' '}
              auto Content-Length
            </label>
            <label className="check">
              timeout
              <input
                type="number"
                min={1}
                style={{ width: 64 }}
                value={tab.timeoutMs / 1000}
                onChange={(e) => update(tab.id, { timeoutMs: Math.max(1, Number(e.target.value) || 30) * 1000 })}
              />
              s
            </label>
            <button className="primary" disabled={tab.sending} onClick={send} title="Ctrl+Enter">
              {tab.sending ? 'Mengirim…' : 'Send'}
            </button>
          </div>
          <div className="split even">
            <div className="pane">
              <textarea
                className="editor grow"
                spellCheck={false}
                value={tab.text}
                onChange={(e) => update(tab.id, { text: e.target.value, error: null })}
              />
              {tab.error && <div className="error-bar">{tab.error}</div>}
            </div>
            <div className="pane detail-body">
              {tab.result?.response ? (
                <>
                  <div className="muted pad">
                    <span className={statusClass(tab.result.response.statusCode)}>{tab.result.response.statusCode}</span> ·{' '}
                    {fmtMs(tab.result.durationMs)} · {fmtBytes(tab.result.response.body.size)} · {tab.result.request.url}
                  </div>
                  <ResponseView res={tab.result.response} />
                </>
              ) : (
                <div className="empty">{tab.sending ? 'Menunggu response…' : 'Response muncul di sini.'}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
