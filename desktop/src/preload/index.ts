import { contextBridge, ipcRenderer } from 'electron';

export interface VeEvent {
  type: string;
  data: unknown;
}

const api = {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('ve:call', method, ...args),
  onEvent: (handler: (event: VeEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: VeEvent) => handler(payload);
    ipcRenderer.on('ve:event', listener);
    return () => ipcRenderer.removeListener('ve:event', listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('veyra', api);

export type VeyraBridge = typeof api;
