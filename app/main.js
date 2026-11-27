const { app, BrowserWindow, ipcMain, session, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const detect = require('./lib/chrome-detect');
const imap = require('./lib/imap-reader');
const ai = require('./lib/ai');
const msoauth = require('./lib/ms-oauth');

// Pull readable text out of a PDF buffer so the assistant can read attachments.
async function pdfText(buffer) {
  try {
    const pdf = require('pdf-parse');
    const data = await pdf(buffer);
    return (data.text || '').trim();
  } catch (e) {
    return '';
  }
}

const PARTITION = 'persist:mailbox0'; // the app's own signed-in session
let win;

// ---- tiny settings store (userData/settings.json) ----
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (e) { return {}; }
}
function saveSettings(s) { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); }

// API keys encrypted at rest with the OS keychain
function setKey(raw) {
  if (!raw) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(raw).toString('base64');
  return 'raw:' + raw;
}
function getKey(stored) {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); } catch (e) { return ''; }
  }
  if (stored.startsWith('raw:')) return stored.slice(4);
  return stored;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Mail',
    backgroundColor: '#0f1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  // tell the window whenever new mail lands on the server, so it can refresh
  imap.setMailListener((email) => {
    if (win && !win.isDestroyed()) win.webContents.send('mail-changed', email);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { imap.disconnectAll(); } catch (e) {} });

// ---- IPC ----

// Who is already logged in, so we can offer one-tap connect.
ipcMain.handle('detect-accounts', async () => {
  try { return { ok: true, accounts: detect.detectGoogleAccounts() }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Which mailbox is connected, if any.
ipcMain.handle('session-status', async () => {
  const s = loadSettings();
  return { signedIn: !!s.account, email: s.account?.email || '' };
});

// Returns the connected account ready to use. For Microsoft/OAuth accounts
// it refreshes the access token when it's close to expiring.
async function getAccount() {
  const s = loadSettings();
  const a = s.account;
  if (!a) return null;
  if (a.provider === 'microsoft') {
    let accessToken = a.accessToken;
    if (!accessToken || !a.expiresAt || Date.now() > a.expiresAt) {
      const refreshed = await msoauth.refresh({
        clientId: s.msClientId, tenant: a.tenant || 'common', refreshToken: getKey(a.refreshEnc),
      });
      a.accessToken = refreshed.accessToken;
      a.refreshEnc = setKey(refreshed.refreshToken);
      a.expiresAt = refreshed.expiresAt;
      saveSettings(s);
      imap.dropConnection(a.email); // reconnect with the new token
      accessToken = refreshed.accessToken;
    }
    return { email: a.email, host: 'outlook.office365.com', accessToken };
  }
  return { email: a.email, host: a.host, pass: getKey(a.passEnc) };
}

// Connect a mailbox over IMAP with an app password / key. Tests before saving.
ipcMain.handle('connect-imap', async (e, { email, pass, host }) => {
  const acct = { email: (email || '').trim(), pass: (pass || '').replace(/\s+/g, ''), host: host || imap.hostFor(email) };
  if (!acct.email || !acct.pass) return { ok: false, error: 'Enter your email and the 16-character key.' };
  try {
    await imap.test(acct);
  } catch (err) {
    return { ok: false, error: friendlyImapError(err) };
  }
  const s = loadSettings();
  s.account = { email: acct.email, host: acct.host, passEnc: setKey(acct.pass) };
  s.connectedEmail = acct.email;
  saveSettings(s);
  return { ok: true, email: acct.email };
});

function friendlyImapError(err) {
  const m = String(err.message || err);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(m))
    return 'That key was not accepted. Make sure 2-Step Verification is on and you pasted the 16-character app password (not your normal password).';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Could not reach the mail server. Check the email address.';
  return m;
}

// Sign in to an Outlook / Microsoft 365 mailbox with Microsoft's own flow.
ipcMain.handle('connect-microsoft', async (e, { email, link }) => {
  const s = loadSettings();
  if (!s.msClientId) {
    return { ok: false, needsSetup: true, error: 'Microsoft sign-in needs a one-time setup (an app ID) in Settings.' };
  }
  const tenant = msoauth.tenantFromLink(link) || 'common';
  try {
    const t = await msoauth.signIn({ clientId: s.msClientId, tenant, loginHint: (email || '').trim() });
    const acct = { email: t.email, host: 'outlook.office365.com', accessToken: t.accessToken };
    await imap.test(acct); // confirm the mailbox actually opens
    s.account = {
      email: t.email, provider: 'microsoft', tenant,
      refreshEnc: setKey(t.refreshToken), accessToken: t.accessToken, expiresAt: t.expiresAt,
    };
    s.connectedEmail = t.email;
    saveSettings(s);
    return { ok: true, email: t.email };
  } catch (err) {
    return { ok: false, error: friendlyMsError(err) };
  }
});

function friendlyMsError(err) {
  const m = String(err.message || err);
  if (/IMAP.*disabled|AUTHENTICATE failed|LOGIN failed|AUTHENTICATIONFAILED/i.test(m))
    return 'Signed in, but this mailbox has IMAP turned off by its administrator, so it can’t be read. You’d need IT to allow it.';
  if (/consent|AADSTS65001|admin/i.test(m))
    return 'Your organisation needs an administrator to approve this app before you can sign in.';
  if (/closed/i.test(m)) return 'Sign-in was cancelled.';
  return m;
}

ipcMain.handle('list-inbox', async (e, { limit, folder }) => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try { return { ok: true, messages: await imap.listMailbox(acct, folder || 'INBOX', { limit: limit || 30 }) }; }
  catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

ipcMain.handle('list-folders', async () => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try { return { ok: true, folders: await imap.listFolders(acct) }; }
  catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

ipcMain.handle('get-snippets', async (e, { ids, folder }) => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try { return { ok: true, snippets: await imap.snippets(acct, folder || 'INBOX', ids) }; }
  catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

ipcMain.handle('read-message', async (e, { id, folder }) => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try {
    const m = await imap.readMessage(acct, id, folder || 'INBOX');
    let body = m.text;
    // read PDF attachments so the assistant can answer about them
    for (const a of m.attachments.filter((x) => x.isPdf)) {
      try {
        const att = await imap.getAttachment(acct, id, a.index, folder || 'INBOX');
        const txt = await pdfText(att.content);
        if (txt) body += `\n\n[PDF attachment: ${a.name}]\n${txt.slice(0, 8000)}`;
      } catch (e) {}
    }
    return { ok: true, body, attachments: m.attachments };
  } catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

// Open an attachment (e.g. a PDF) in its own window.
ipcMain.handle('open-attachment', async (e, { id, index, folder }) => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try {
    const att = await imap.getAttachment(acct, id, index, folder || 'INBOX');
    const dir = path.join(os.tmpdir(), 'mail-attachments');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (att.name || 'file').replace(/[^\w.\-]+/g, '_');
    const file = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, att.content);
    if (/pdf/i.test(att.type || '') || /\.pdf$/i.test(att.name || '')) {
      const pv = new BrowserWindow({ width: 800, height: 950, title: att.name });
      pv.loadURL('file://' + file);
    } else {
      shell.openPath(file);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

ipcMain.handle('search-mail', async (e, { query, folder }) => {
  const acct = await getAccount();
  if (!acct) return { ok: false, error: 'No mailbox connected.' };
  try { return { ok: true, messages: await imap.search(acct, query, folder || 'INBOX') }; }
  catch (err) { return { ok: false, error: friendlyImapError(err) }; }
});

ipcMain.handle('open-external', async (e, { url }) => { shell.openExternal(url); return { ok: true }; });

// Ask Microsoft whether an email's domain is a Microsoft 365 tenant,
// so a company address (you@company.com) can offer Microsoft sign-in.
ipcMain.handle('detect-mail-provider', async (e, { email }) => {
  const addr = (email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ok: true, microsoft: false };
  try {
    const res = await fetch(`https://login.microsoftonline.com/getuserrealm.srf?login=${encodeURIComponent(addr)}&json=1`);
    const j = await res.json();
    const brand = j.FederationBrandName || '';
    // "Managed" = a Microsoft 365 cloud tenant. "Federated" is a real org tenant
    // too UNLESS it's the consumer "Windows Live" realm (what unknown domains map to).
    const microsoft = j.NameSpaceType === 'Managed'
      || (j.NameSpaceType === 'Federated' && !/windows live|microsoft account/i.test(brand));
    return { ok: true, microsoft: !!microsoft };
  } catch (err) {
    return { ok: true, microsoft: false };
  }
});

ipcMain.handle('ai-models', async () => ({ ollama: await ai.ollamaModels() }));

ipcMain.handle('get-settings', async () => {
  const s = loadSettings();
  return {
    provider: s.provider || 'ollama',
    model: s.model || '',
    baseUrl: s.baseUrl || '',
    hasKey: !!s.apiKey,
    connectedEmail: s.connectedEmail || '',
    instructions: s.instructions || '',
    keywords: s.keywords || [],
    msClientId: s.msClientId || '',
  };
});

ipcMain.handle('save-settings', async (e, incoming) => {
  const s = loadSettings();
  s.provider = incoming.provider;
  s.model = incoming.model;
  s.baseUrl = incoming.baseUrl || '';
  if (incoming.apiKey) s.apiKey = setKey(incoming.apiKey); // only overwrite if a new one typed
  if (incoming.instructions !== undefined) s.instructions = incoming.instructions;
  if (incoming.keywords !== undefined) s.keywords = incoming.keywords;
  if (incoming.msClientId !== undefined) s.msClientId = incoming.msClientId.trim();
  saveSettings(s);
  return { ok: true };
});

// Run one AI turn; stream tokens back to the renderer.
ipcMain.handle('ai-chat', async (e, { messages }) => {
  const s = loadSettings();
  const cfg = {
    provider: s.provider || 'ollama',
    model: s.model || 'qwen3.5:2b',
    apiKey: getKey(s.apiKey),
    baseUrl: s.baseUrl || '',
  };
  try {
    const full = await ai.chat(cfg, messages, (t) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai-token', t);
    });
    return { ok: true, full };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
