import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ProxyKitApi } from '../shared/api.js';

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void) => {
    const fn = (_e: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };

const api = {
  ...Object.fromEntries(IPC.invoke.map((c) => [c, invoke(c)])),
  onHistoryChanged: subscribe(IPC.events.historyChanged),
  onHeld: subscribe(IPC.events.held),
  onResolved: subscribe(IPC.events.resolved),
  onLog: subscribe(IPC.events.log),
  onStatus: subscribe(IPC.events.status),
} as unknown as ProxyKitApi;

contextBridge.exposeInMainWorld('proxykit', api);
