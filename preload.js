const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('shell', {
  appName: call('app:name'),
  authStatus: call('auth:status'),
  authSetup: call('auth:setup'),
  authUnlock: call('auth:unlock'),
  lock: call('auth:lock'),
  apps: call('apps:list'),
  status: call('status:get'),
  start: call('app:start'),
  stop: call('app:stop'),
  saveApp: call('app:save'),
  removeApp: call('app:remove'),
  pick: call('pick'),
  openNotes: call('notes:openTab'),
  activate: call('tab:activate'),
  close: call('tab:close'),
  clear: call('cache:clear'),
  cacheSize: call('cache:size'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onAuth: (cb) => ipcRenderer.on('auth', (_e, s) => cb(s)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onNotice: (cb) => ipcRenderer.on('notice', (_e, s) => cb(s)),
});
