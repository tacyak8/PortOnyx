const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('notes', {
  info: call('notes:info'),
  list: call('notes:list'),
  read: call('notes:read'),
  save: call('notes:save'),
  create: call('notes:create'),
  rename: call('notes:rename'),
  move: call('notes:move'),
  remove: call('notes:delete'),
  catCreate: call('notes:catCreate'),
  catRename: call('notes:catRename'),
  catDelete: call('notes:catDelete'),
  chooseDir: call('notes:chooseDir'),
  openFile: call('notes:openFile'),
  importCopy: call('notes:import'),
});
