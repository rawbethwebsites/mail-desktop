// Detects which Google / Microsoft accounts are already signed in to the
// browsers on this computer, by reading the browser's own login store.
// This is detection only — it tells us WHO is logged in so connecting feels
// like one tap. It does not (and can't) replay those sessions; the actual
// mailbox is read after an in-app sign-in.

const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function chromeRoot() {
  return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
}

// macOS: the AES key Chrome uses lives in the login keychain.
let _key = null;
function macKey() {
  if (_key) return _key;
  const pw = execSync(
    `security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"`
  ).toString().trim();
  _key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  return _key;
}

function decryptMac(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (!buf.length) return '';
  if (buf.slice(0, 3).toString() !== 'v10') return buf.toString();
  const d = crypto.createDecipheriv('aes-128-cbc', macKey(), Buffer.alloc(16, ' '));
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(buf.slice(3)), d.final()]);
  out = out.slice(0, out.length - out[out.length - 1]);
  return out.slice(32).toString('utf8'); // strip 32-byte domain hash prefix
}

// Read the human-friendly profile names Chrome stores (name + email).
function listProfiles() {
  const root = chromeRoot();
  const stateFile = path.join(root, 'Local State');
  const out = [];
  if (!fs.existsSync(stateFile)) return out;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const cache = state.profile?.info_cache || {};
    for (const [dir, info] of Object.entries(cache)) {
      out.push({ dir, name: info.name || dir, email: info.user_name || '' });
    }
  } catch (e) {}
  return out;
}

// For one profile, which Google account is actively signed in (has auth cookies)?
function googleLoginInProfile(profileDir) {
  const root = chromeRoot();
  const cookies = path.join(root, profileDir, 'Cookies');
  if (!fs.existsSync(cookies)) return null;
  const tmp = path.join(os.tmpdir(), `md-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    execSync(`cp "${cookies}" "${tmp}"`);
    const dump = execSync(
      `sqlite3 "${tmp}" "SELECT name FROM cookies WHERE host_key LIKE '%google.com';"`
    ).toString();
    const names = new Set(dump.split('\n').map((s) => s.trim()).filter(Boolean));
    const signedIn = names.has('SID') && names.has('SAPISID');
    return signedIn;
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// Public: a list of Google accounts we can see are logged in, ready to offer.
function detectGoogleAccounts() {
  const results = [];
  for (const p of listProfiles()) {
    const looksGoogle = /@/.test(p.email);
    let signedIn = null;
    try { signedIn = googleLoginInProfile(p.dir); } catch (e) {}
    if (signedIn) {
      results.push({
        provider: 'google',
        email: looksGoogle ? p.email : '(unknown Google account)',
        label: p.name,
        source: `Chrome · ${p.name}`,
        profileDir: p.dir,
      });
    }
  }
  return results;
}

module.exports = { detectGoogleAccounts, listProfiles };
