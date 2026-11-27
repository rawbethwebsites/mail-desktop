const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mail', {
  detectAccounts: () => ipcRenderer.invoke('detect-accounts'),
  sessionStatus: () => ipcRenderer.invoke('session-status'),
  connectImap: (email, pass, host) => ipcRenderer.invoke('connect-imap', { email, pass, host }),
  connectMicrosoft: (email, link) => ipcRenderer.invoke('connect-microsoft', { email, link }),
  listInbox: (limit, folder) => ipcRenderer.invoke('list-inbox', { limit, folder }),
  listFolders: () => ipcRenderer.invoke('list-folders'),
  getSnippets: (ids, folder) => ipcRenderer.invoke('get-snippets', { ids, folder }),
  readMessage: (id, folder) => ipcRenderer.invoke('read-message', { id, folder }),
  openAttachment: (id, index, folder) => ipcRenderer.invoke('open-attachment', { id, index, folder }),
  searchMail: (query, folder) => ipcRenderer.invoke('search-mail', { query, folder }),
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
  detectMailProvider: (email) => ipcRenderer.invoke('detect-mail-provider', { email }),
  aiModels: () => ipcRenderer.invoke('ai-models'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  aiChat: (messages) => ipcRenderer.invoke('ai-chat', { messages }),
  onToken: (cb) => ipcRenderer.on('ai-token', (_e, t) => cb(t)),
  onMailChanged: (cb) => ipcRenderer.on('mail-changed', (_e, email) => cb(email)),
});
