// "Sign in with Microsoft" for Outlook / Microsoft 365 mailboxes.
// OAuth2 auth-code flow with PKCE (public client, no secret), done in a
// real Microsoft sign-in window so the person's normal flow — password,
// OTP, an admin activation link — all work. We ask only for read-only IMAP
// access, then read the mailbox over IMAP using the token (XOAUTH2).

const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');

const REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPE = 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access openid email';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authority(tenant) {
  // tenant: 'common' (default), 'organizations', 'consumers', or a tenant id/domain
  return `https://login.microsoftonline.com/${tenant || 'common'}`;
}

// Open the Microsoft sign-in window and return the authorization code.
function getAuthCode({ clientId, tenant, loginHint, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    response_mode: 'query',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (loginHint) params.set('login_hint', loginHint);
  const url = `${authority(tenant)}/oauth2/v2.0/authorize?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520, height: 700, title: 'Sign in with Microsoft',
      autoHideMenuBar: true,
      webPreferences: { partition: `ms-signin-${Date.now()}`, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; try { if (!win.isDestroyed()) win.close(); } catch (e) {} fn(arg); };

    const inspect = (navUrl) => {
      if (!navUrl || navUrl.indexOf(REDIRECT) !== 0) return;
      const u = new URL(navUrl);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (code) finish(resolve, code);
      else if (err) finish(reject, new Error(decodeURIComponent(err)));
    };
    win.webContents.on('will-redirect', (e, navUrl) => inspect(navUrl));
    win.webContents.on('did-navigate', (e, navUrl) => inspect(navUrl));
    win.webContents.on('did-redirect-navigation', (e, navUrl) => inspect(navUrl));
    win.on('closed', () => finish(reject, new Error('Sign-in window was closed.')));
    win.loadURL(url);
  });
}

async function exchange({ clientId, tenant, body }) {
  const res = await fetch(`${authority(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, scope: SCOPE, ...body }).toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || `token error ${res.status}`);
  return json; // { access_token, refresh_token, expires_in, ... }
}

// Full interactive sign-in. Returns { email, accessToken, refreshToken, expiresAt }.
async function signIn({ clientId, tenant, loginHint }) {
  const { verifier, challenge } = pkce();
  const code = await getAuthCode({ clientId, tenant, loginHint, challenge });
  const tok = await exchange({ clientId, tenant, body: {
    grant_type: 'authorization_code', code, code_verifier: verifier,
  } });
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
    email: emailFromToken(tok.id_token) || loginHint || '',
  };
}

// Silent refresh with a stored refresh token.
async function refresh({ clientId, tenant, refreshToken }) {
  const tok = await exchange({ clientId, tenant, body: {
    grant_type: 'refresh_token', refresh_token: refreshToken,
  } });
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || refreshToken,
    expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
  };
}

function emailFromToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload.preferred_username || payload.email || '';
  } catch (e) { return ''; }
}

// Pull a tenant hint out of a sign-in link an admin may have shared.
function tenantFromLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link.includes('://') ? link : 'https://' + link);
    // .../{tenant}/oauth2/... or ?tenant=... or a verified domain in the host
    const m = u.pathname.match(/\/([0-9a-f-]{36}|[\w.-]+\.onmicrosoft\.com)\//i);
    if (m) return m[1];
    const q = u.searchParams.get('tenant') || u.searchParams.get('domain_hint');
    if (q) return q;
  } catch (e) {}
  return '';
}

module.exports = { signIn, refresh, tenantFromLink };
