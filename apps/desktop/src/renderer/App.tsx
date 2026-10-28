import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeldItemDTO, LogEntry, ProxyStatus, RequestDTO } from '../shared/api';
import { api } from './api';
import { EventsView } from './components/EventsView';
import { HistoryView } from './components/HistoryView';
import { InterceptView } from './components/InterceptView';
import { newRepeaterTab, RepeaterView, type RepeaterTab } from './components/RepeaterView';
import { SettingsView } from './components/SettingsView';
import { errMsg } from './util';

type View = 'history' | 'intercept' | 'repeater' | 'events' | 'settings';
const VIEWS: [View, string][] = [
  ['history', 'History'],
  ['intercept', 'Intercept'],
  ['repeater', 'Repeater'],
  ['events', 'Events'],
  ['settings', 'Settings'],
];

interface Toast {
  id: number;
  msg: string;
  level: 'info' | 'error';
}

export function App() {
  const [view, setView] = useState<View>('history');
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [held, setHeld] = useState<HeldItemDTO[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [repTabs, setRepTabs] = useState<RepeaterTab[]>([]);
  const [repActive, setRepActive] = useState<number | null>(null);
  const toastSeq = useRef(0);

  const notify = useCallback((msg: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, msg, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 6000 : 3000);
  }, []);

  useEffect(() => {
    void api.status().then(setStatus);
    void api.listHeld().then(setHeld);
    void api.logs().then((l) => setLogs([...l]));
    const offs = [
      api.onStatus(setStatus),
      api.onHeld((item) => setHeld((h) => (h.some((x) => x.key === item.key) ? h : [...h, item]))),
      api.onResolved((info) => setHeld((h) => h.filter((x) => x.key !== info.key))),
      api.onLog((entry) => setLogs((l) => [...l.slice(-999), entry])),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= VIEWS.length) {
        e.preventDefault();
        setView(VIEWS[n - 1][0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sendToRepeater = useCallback((req: RequestDTO, parentId: string) => {
    const tab = newRepeaterTab(req, parentId);
    setRepTabs((t) => [...t, tab]);
    setRepActive(tab.id);
    setView('repeater');
  }, []);

  const addRepTab = () => {
    const tab = newRepeaterTab();
    setRepTabs((t) => [...t, tab]);
    setRepActive(tab.id);
  };


  const toggleProxy = () => (status?.running ? api.stopProxy() : api.startProxy()).catch((e) => notify(errMsg(e), 'error'));
  const tlsErrors = logs.filter((l) => l.kind === 'tls-error').length;
  const interceptOn = !!(status?.settings.intercept.requests || status?.settings.intercept.responses);
  // ON -> matikan request & response sekaligus (yang tertahan otomatis di-forward); OFF -> tahan request.
  const toggleIntercept = () => {
    api
      .configureIntercept(interceptOn ? { requests: false, responses: false } : { requests: true })
      .catch((e) => notify(errMsg(e), 'error'));
    if (!interceptOn) setView('intercept');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">ProxyKit</div>
        <button className={`pill ${status?.running ? 'ok' : 'bad'}`} onClick={toggleProxy} title="Start / stop proxy">
          <span className="dot" />
          {status?.running ? 'Running' : status?.error ? 'Error' : 'Stopped'}
        </button>
        <div className="addr" title={status?.addresses.join('\n')}>
          {status?.running ? (
            <>
              <code>{status.addresses[0]}</code>
              {status.addresses.length > 1 && <span className="muted"> · LAN {status.addresses.slice(1).join(', ')}</span>}
            </>
          ) : (
            <span className="err">{status?.error ?? ''}</span>
          )}
        </div>
        <span className="grow" />
        <button className={`pill ${interceptOn ? 'warn' : ''}`} onClick={toggleIntercept} title="Toggle tahan request">
          Intercept {interceptOn ? 'ON' : 'OFF'}
        </button>
        <button onClick={() => api.exportCA().then((p) => p && notify(`CA disimpan: ${p}`)).catch((e) => notify(errMsg(e), 'error'))}>
          Export CA
        </button>
      </header>

      <nav className="tabs main">
        {VIEWS.map(([v, label], i) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={`Ctrl+${i + 1}`}>
            {label}
            {v === 'intercept' && held.length > 0 && <span className="badge warn">{held.length}</span>}
            {v === 'events' && tlsErrors > 0 && <span className="badge bad">{tlsErrors}</span>}
            {v === 'repeater' && repTabs.length > 0 && <span className="badge">{repTabs.length}</span>}
          </button>
        ))}
        <span className="grow" />
        <span className="muted counter">{status ? `${status.historyCount} exchange` : ''}</span>
      </nav>

      <main>
        {/* History tetap mounted supaya filter & seleksi tidak hilang saat pindah tab. */}
        <div className={view === 'history' ? 'show' : 'hide'}>
          <HistoryView onSendToRepeater={sendToRepeater} notify={notify} />
        </div>
        {view === 'intercept' && <InterceptView held={held} status={status} notify={notify} />}
        {view === 'repeater' && (
          <RepeaterView
            tabs={repTabs}
            activeId={repActive}
            setActive={setRepActive}
            update={(id, patch) => setRepTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))}
            add={addRepTab}
            close={(id) => {
              setRepTabs((ts) => ts.filter((t) => t.id !== id));
              if (repActive === id) setRepActive(null);
            }}
          />
        )}
        {view === 'events' && <EventsView logs={logs} status={status} notify={notify} />}
        {view === 'settings' && <SettingsView status={status} notify={notify} />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
