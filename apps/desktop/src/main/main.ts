import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IPC, type InvokeChannel } from '../shared/api.js';
import { Engine } from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.PROXYKIT_DEV_URL;
const rendererIndex = join(here, '../renderer/index.html');
// Default sama dengan CLI (~/.proxykit) supaya CA yang sudah di-trust di device tetap kepakai.
const dataDir = resolve(process.env.PROXYKIT_DATA_DIR ?? join(homedir(), '.proxykit'));
const envPort = process.env.PROXYKIT_PORT !== undefined ? Number(process.env.PROXYKIT_PORT) : undefined;

let win: BrowserWindow | null = null;
let engine: Engine;

/** Hanya terima IPC dari halaman app sendiri (bukan frame / URL lain kalau sampai ter-navigate). */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (devUrl) return url.startsWith(devUrl);
  return url === pathToFileURL(rendererIndex).toString() || url.startsWith(pathToFileURL(rendererIndex).toString() + '#');
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const handlers: Record<InvokeChannel, (...args: any[]) => unknown> = {
  status: () => engine.status(),
  startProxy: () => engine.start(),
  stopProxy: () => engine.stop(),
  updateSettings: (patch) => engine.updateSettings(patch),
  configureIntercept: (patch) => engine.configureIntercept(patch),
  listHistory: (filter) => engine.listHistory(filter ?? {}),
  getExchange: (id: string) => engine.getExchange(id),
  listWs: (id: string) => engine.listWs(id),
  clearHistory: () => engine.clearHistory(),
  exportHar: async (filter) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export HAR',
      defaultPath: `proxykit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.har`,
      filters: [{ name: 'HAR', extensions: ['har'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, engine.har(filter ?? {}));
    return r.filePath;
  },
  listHeld: () => engine.listHeld(),
  forward: (key: string, edit) => engine.forward(key, edit),
  drop: (key: string, mode, response) => engine.drop(key, mode, response),
  forwardAll: () => engine.forwardAll(),
  dropAll: () => engine.dropAll(),
  sendRepeater: (req, parentId) => engine.sendRepeater(req, parentId),
  exportCA: async () => {
    const pem = engine.caCertPem();
    if (!pem) throw new Error('CA belum dibuat, start proxy dulu');
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export CA certificate',
      // .crt diterima installer cert Android & Windows; isi PEM juga bisa langsung dipakai iOS/macOS.
      defaultPath: 'proxykit-ca.crt',
      filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, pem);
    return r.filePath;
  },
  openDataDir: () => shell.openPath(dataDir).then(() => undefined),
  copyText: (text: string) => clipboard.writeText(String(text)),
  logs: () => engine.logs(),
};

function registerIpc(): void {
  for (const channel of IPC.invoke) {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!trusted(e)) throw new Error('IPC ditolak: sender tidak dikenal');
      return handlers[channel](...args);
    });
  }
  engine.on('history-changed', (ids) => send(IPC.events.historyChanged, ids));
  engine.on('held', (item) => {
    send(IPC.events.held, item);
    // Kasih tanda di taskbar kalau ada traffic ketahan dan window tidak fokus.
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  engine.on('resolved', (info) => send(IPC.events.resolved, info));
  engine.on('log', (entry) => send(IPC.events.log, entry));
  engine.on('status', (s) => send(IPC.events.status, s));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'ProxyKit',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Renderer menampilkan traffic dari target (untrusted): jangan pernah navigate / buka window baru.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => (win = null));

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererIndex);
}

// Satu instance saja: dua instance akan rebutan port & history.db.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    engine = new Engine(dataDir, envPort);
    registerIpc();
    createWindow();
    await engine.start();
  });

  app.on('window-all-closed', () => app.quit());

  let disposed = false;
  app.on('before-quit', (e) => {
    if (disposed || !engine) return;
    e.preventDefault();
    disposed = true;
    void engine.dispose().finally(() => app.quit());
  });
}
