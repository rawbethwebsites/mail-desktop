// Direct, read-only mail over IMAP. Works with Gmail (app password),
// iCloud, Yahoo, Zoho, and most company mail. Reliable and complete:
// full bodies, all folders, real search — nothing scraped.
//
// Connections are kept alive per account (keyed by email) so opening an
// email is instant after the first fetch, instead of reconnecting each time.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { convert } = require('html-to-text');

// Turn an email's HTML into clean, readable text (no raw tracking URLs, no CSS).
function htmlToText(html) {
  if (!html) return '';
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim();
}

const HOSTS = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com',
  'hotmail.com': 'outlook.office365.com',
  'live.com': 'outlook.office365.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'zoho.com': 'imap.zoho.com',
};
function hostFor(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  return HOSTS[domain] || `imap.${domain}`;
}

// ---- connection pool ----
const pool = new Map(); // email -> { client, acct, mailbox }
let mailListener = null; // called (email) when new mail arrives on an open mailbox
function setMailListener(fn) { mailListener = fn; }

async function getClient(acct) {
  const key = acct.email;
  let entry = pool.get(key);
  if (entry && entry.client.usable) return entry;
  // (re)connect
  const client = new ImapFlow({
    host: acct.host || hostFor(acct.email),
    port: 993,
    secure: true,
    // Microsoft/OAuth accounts use a token (XOAUTH2); others use the app password.
    auth: acct.accessToken
      ? { user: acct.email, accessToken: acct.accessToken }
      : { user: acct.email, pass: acct.pass },
    logger: false,
    emitLogs: false,
  });
  client.on('error', () => {}); // keep the pool from crashing on idle drops
  // imapflow idles automatically between commands; 'exists' fires on new mail
  client.on('exists', () => { if (mailListener) mailListener(acct.email); });
  await client.connect();
  entry = { client, acct, mailbox: null };
  pool.set(key, entry);
  return entry;
}

// serialize operations per account (IMAP is one-command-at-a-time)
const locks = new Map();
async function run(acct, mailbox, fn) {
  const key = acct.email;
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(key, prev.then(() => next));
  await prev.catch(() => {});
  try {
    const entry = await getClient(acct);
    if (entry.mailbox !== mailbox) {
      await entry.client.mailboxOpen(mailbox);
      entry.mailbox = mailbox;
    }
    return await fn(entry.client);
  } catch (e) {
    // drop a broken connection so the next call reconnects cleanly
    const entry = pool.get(key);
    if (entry) { try { entry.client.close(); } catch (x) {} pool.delete(key); }
    throw e;
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

async function test(acct) {
  return run(acct, 'INBOX', async () => ({ ok: true }));
}

async function listFolders(acct) {
  return run(acct, 'INBOX', async (client) => {
    const list = await client.list();
    // surface the common ones in a sensible order
    const want = ['INBOX', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Flagged', '\\All'];
    const out = [];
    for (const box of list) {
      const special = box.specialUse || (box.path === 'INBOX' ? 'INBOX' : '');
      out.push({ path: box.path, name: box.name, special });
    }
    return out;
  });
}

async function listMailbox(acct, mailbox = 'INBOX', { limit = 30 } = {}) {
  return run(acct, mailbox, async (client) => {
    const status = await client.status(mailbox, { messages: true });
    const total = status.messages || 0;
    if (!total) return [];
    const start = Math.max(1, total - limit + 1);
    const out = [];
    for await (const m of client.fetch(`${start}:*`, {
      uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true,
    })) {
      const from = m.envelope?.from?.[0];
      out.push({
        id: String(m.uid),
        account: acct.email,
        from: from ? (from.name || from.address) : '(unknown)',
        fromAddr: from?.address || '',
        subject: m.envelope?.subject || '(no subject)',
        date: m.internalDate || m.envelope?.date || null,
        dateLabel: fmtDate(m.internalDate || m.envelope?.date),
        snippet: '',
        unread: !(m.flags && m.flags.has('\\Seen')),
        hasAttachments: hasAtt(m.bodyStructure),
      });
    }
    out.reverse();
    return out;
  });
}

// Pull short preview text for a set of uids (fast TEXT peek, read-only).
async function snippets(acct, mailbox, uids) {
  if (!uids.length) return {};
  return run(acct, mailbox, async (client) => {
    const map = {};
    for (const uid of uids) {
      try {
        const dl = await client.download(String(uid), '1', { uid: true, maxBytes: 2048 });
        if (dl && dl.content) {
          const chunks = [];
          for await (const c of dl.content) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8');
          const text = (/<[a-z!][^>]*>/i.test(raw) ? htmlToText(raw) : raw)
            .replace(/\s+/g, ' ').trim();
          map[uid] = text.slice(0, 140);
        }
      } catch (e) {}
    }
    return map;
  });
}

async function readMessage(acct, uid, mailbox = 'INBOX') {
  return run(acct, mailbox, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return { text: '(could not open)', attachments: [] };
    const parsed = await simpleParser(msg.source);
    // prefer plain text; fall back to clean HTML-to-text (not a raw tag strip)
    let text = (parsed.text && parsed.text.trim()) ? parsed.text.trim() : htmlToText(parsed.html || '');
    text = tidy(text);
    const attachments = (parsed.attachments || []).map((a, i) => ({
      index: i, name: a.filename || `attachment-${i}`,
      size: a.size, type: a.contentType,
      isPdf: /pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || ''),
    }));
    return {
      text: text.slice(0, 40000),
      subject: parsed.subject || '',
      from: parsed.from?.text || '',
      date: parsed.date ? fmtDate(parsed.date) : '',
      attachments,
      _hasPdf: attachments.some((a) => a.isPdf),
    };
  });
}

// Return one attachment's bytes (for viewing or text extraction).
async function getAttachment(acct, uid, index, mailbox = 'INBOX') {
  return run(acct, mailbox, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('message not found');
    const parsed = await simpleParser(msg.source);
    const a = (parsed.attachments || [])[index];
    if (!a) throw new Error('attachment not found');
    return { name: a.filename || `attachment-${index}`, type: a.contentType, content: a.content };
  });
}

// Server-side search across the whole mailbox.
async function search(acct, query, mailbox = 'INBOX', { limit = 25 } = {}) {
  return run(acct, mailbox, async (client) => {
    const uids = await client.search(
      { or: [{ subject: query }, { body: query }, { from: query }, { to: query }] },
      { uid: true }
    );
    const pick = uids.slice(-limit).reverse();
    const out = [];
    for (const uid of pick) {
      const m = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true });
      const from = m.envelope?.from?.[0];
      out.push({
        id: String(uid), account: acct.email,
        from: from ? (from.name || from.address) : '(unknown)',
        subject: m.envelope?.subject || '(no subject)',
        dateLabel: fmtDate(m.internalDate),
      });
    }
    return out;
  });
}

// Collapse long tracking URLs and runs of blank lines so email reads cleanly.
function tidy(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s)]{45,}/g, '[link]')
    .replace(/\(\s*\[link\]\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/^[ \t]*[|>]+[ \t]*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasAtt(bs) {
  if (!bs) return false;
  if (bs.disposition === 'attachment') return true;
  if (bs.childNodes) return bs.childNodes.some(hasAtt);
  return false;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  if (dt.toDateString() === now.toDateString()) return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dt.getFullYear() === now.getFullYear()) return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
}

function disconnectAll() {
  for (const { client } of pool.values()) { try { client.logout(); } catch (e) {} }
  pool.clear();
}

// Drop one account's pooled connection (e.g. after its OAuth token refreshed).
function dropConnection(email) {
  const entry = pool.get(email);
  if (entry) { try { entry.client.close(); } catch (e) {} pool.delete(email); }
}

module.exports = {
  test, listFolders, listMailbox, snippets, readMessage, getAttachment, search,
  hostFor, disconnectAll, setMailListener, dropConnection,
};
