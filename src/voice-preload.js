'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceStudio', {
  state: () => ipcRenderer.invoke('voice-studio:state'),
  prepare: () => ipcRenderer.invoke('voice-studio:prepare'),
  create: (request) => ipcRenderer.invoke('voice-studio:create', request),
  test: (request) => ipcRenderer.invoke('voice-studio:test', request),
  activate: (request) => ipcRenderer.invoke('voice-studio:activate', request),
  remove: (id) => ipcRenderer.invoke('voice-studio:delete', id),
  stop: () => ipcRenderer.invoke('voice-studio:stop'),
  docs: (name) => ipcRenderer.invoke('voice-studio:docs', name),
  onProgress: (fn) => { const listener = (_event, payload) => fn(payload); ipcRenderer.on('voice-studio:progress', listener);
    return () => ipcRenderer.removeListener('voice-studio:progress', listener); },
});
