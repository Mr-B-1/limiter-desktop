import { contextBridge, ipcRenderer } from 'electron';
import type { DisplayState, Theme, WidgetBridge } from './shared/usage.js';

const bridge: WidgetBridge = {
  state: () => ipcRenderer.invoke('limiter:state'),
  refresh: () => ipcRenderer.invoke('limiter:refresh'),
  theme: (value: Theme) => ipcRenderer.invoke('limiter:theme', value),
  hide: () => ipcRenderer.invoke('limiter:hide'),
  quit: () => ipcRenderer.invoke('limiter:quit'),
  resize: request => ipcRenderer.invoke('limiter:resize', request),
  chooseSource: () => ipcRenderer.invoke('limiter:choose-source'),
  chooseFolder: kind => ipcRenderer.invoke('limiter:choose-folder', kind),
  updateSettings: change => ipcRenderer.invoke('limiter:update-settings', change),
  firstRunSeen: () => ipcRenderer.invoke('limiter:first-run-seen'),
  calibrateClaude: reading => ipcRenderer.invoke('limiter:calibrate-claude', reading),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: DisplayState) => listener(state);
    ipcRenderer.on('limiter:changed', receive);
    return () => ipcRenderer.removeListener('limiter:changed', receive);
  }
};
contextBridge.exposeInMainWorld('limiter', Object.freeze(bridge));
