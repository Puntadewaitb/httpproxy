import type { ProxyKitApi } from '../shared/api';

declare global {
  interface Window {
    proxykit: ProxyKitApi;
  }
}

export const api = window.proxykit;
