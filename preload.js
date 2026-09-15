// Exposes a small, safe API surface to the renderer via contextBridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ollama', {
  version: () => ipcRenderer.invoke('ollama:version'),
  tags: () => ipcRenderer.invoke('ollama:tags'),
  ps: () => ipcRenderer.invoke('ollama:ps'),
  show: (name) => ipcRenderer.invoke('ollama:show', name),
  delete: (name) => ipcRenderer.invoke('ollama:delete', name),
  pull: (name) => ipcRenderer.invoke('ollama:pull', name),
  chat: (payload) => ipcRenderer.invoke('ollama:chat', payload),
  stop: (streamId) => ipcRenderer.invoke('ollama:stop', streamId),
  start: () => ipcRenderer.invoke('ollama:start'),

  // Streaming event subscriptions — return an unsubscribe fn.
  onChatToken: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ollama:chat-token', h);
    return () => ipcRenderer.removeListener('ollama:chat-token', h);
  },
  onChatDone: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ollama:chat-done', h);
    return () => ipcRenderer.removeListener('ollama:chat-done', h);
  },
  onChatError: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ollama:chat-error', h);
    return () => ipcRenderer.removeListener('ollama:chat-error', h);
  },
  onPullProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('ollama:pull-progress', h);
    return () => ipcRenderer.removeListener('ollama:pull-progress', h);
  },
});

contextBridge.exposeInMainWorld('sys', {
  stats: () => ipcRenderer.invoke('sys:stats'),
});

contextBridge.exposeInMainWorld('app', {
  version: () => ipcRenderer.invoke('app:version'),
});

contextBridge.exposeInMainWorld('ui', {
  confirm: (opts) => ipcRenderer.invoke('ui:confirm', opts),
  setTitleBarTheme: (theme) => ipcRenderer.invoke('ui:titlebar-theme', theme),
});
