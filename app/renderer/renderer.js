const $ = (s) => document.querySelector(s);
const el = (s) => document.querySelectorAll(s);

let messages = [];        // inbox list
let openMsg = null;       // currently open message {id, from, subject, body}
let mode = 'this';        // chat scope: this | all
let chatHistory = [];     // {role, content}
let prefs = { instructions: '', keywords: [] };  // from settings

async function loadPrefs() {
  const s = await window.mail.getSettings();
  prefs.instructions = s.instructions || '';
  prefs.keywords = s.keywords || [];
  renderKeywordBar();
}

function renderKeywordBar() {
  const bar = document.getElementById('kwbar');
  if (!prefs.keywords.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  for (const kw of prefs.keywords) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = kw;
    c.onclick = () => {
      document.getElementById('search').value = kw;
      const q = kw.toLowerCase();
      renderList(messages.filter((m) => (m.from + ' ' + m.subject + ' ' + m.snippet).toLowerCase().includes(q)));
    };
    bar.appendChild(c);
  }
}

// ---------- connect / accounts ----------
const AV_COLORS = ['#6c8cff','#54d08a','#ff9f6c','#c17cff','#4fc3d6','#f075a8','#e0b84c','#7c9bff'];
function avatarColor(s) {
  let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initial(s) { return (String(s).trim()[0] || '?').toUpperCase(); }

async function refreshStatus() {
  const st = await window.mail.sessionStatus();
  if (st.signedIn) {
    $('#whoami').textContent = st.email || 'connected';
    $('#whoami').classList.add('ok');
    $('#connectBtn').textContent = 'Reconnect';
    // connected: show compact account chip, hide the big add-mailbox block
    $('#acctBox').style.display = 'none';
    $('#connectedBox').style.display = 'block';
    $('#acctAv').textContent = initial(st.email);
    $('#acctAv').style.background = avatarColor(st.email);
    $('#acctEm').textContent = st.email;
    loadInbox();
  } else {
    $('#whoami').textContent = 'not connected';
    $('#acctBox').style.display = 'block';
    $('#connectedBox').style.display = 'none';
  }
  // detected logins → one-tap chips (only needed before first connect)
  const d = await window.mail.detectAccounts();
  const box = $('#detected');
  box.innerHTML = '';
  if (d.ok && d.accounts.length) {
    for (const a of d.accounts) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.style.cssText = 'width:100%;text-align:left;margin-bottom:6px;overflow:hidden';
      b.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.email}</div><div class="muted">found in ${a.source} · tap to connect</div>`;
      b.onclick = () => connect(/@/.test(a.email) ? a.email : '');
      box.appendChild(b);
    }
  } else {
    box.innerHTML = '<div class="muted" style="font-size:12px">No signed-in browser accounts detected.</div>';
  }
}

// How to connect each provider: the app-password page and wording.
const PROVIDERS = {
  'gmail.com':      { name: 'Gmail', link: 'https://myaccount.google.com/apppasswords', keyLabel: 'One-time key', help: 'Sign in if asked, name it “Mail”, and Google shows a 16-character code. Paste it below.', ph: 'abcd efgh ijkl mnop' },
  'googlemail.com': { name: 'Gmail', link: 'https://myaccount.google.com/apppasswords', keyLabel: 'One-time key', help: 'Sign in if asked, name it “Mail”, and Google shows a 16-character code. Paste it below.', ph: 'abcd efgh ijkl mnop' },
  'yahoo.com':      { name: 'Yahoo', link: 'https://login.yahoo.com/account/security/app-passwords', keyLabel: 'App password', help: 'Generate an app password for “Mail”, then paste it below.', ph: 'app password' },
  'icloud.com':     { name: 'iCloud', link: 'https://appleid.apple.com/account/manage', keyLabel: 'App-specific password', help: 'Sign in → App-Specific Passwords → generate one, then paste it below.', ph: 'xxxx-xxxx-xxxx-xxxx' },
  'me.com':         { name: 'iCloud', link: 'https://appleid.apple.com/account/manage', keyLabel: 'App-specific password', help: 'Sign in → App-Specific Passwords → generate one, then paste it below.', ph: 'xxxx-xxxx-xxxx-xxxx' },
  'zoho.com':       { name: 'Zoho', link: 'https://accounts.zoho.com/home#security/app_password', keyLabel: 'App password', help: 'Create an app password for “Mail”, then paste it below.', ph: 'app password' },
  'outlook.com':    { microsoft: true },
  'hotmail.com':    { microsoft: true },
  'live.com':       { microsoft: true },
};
function providerFor(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (forcedMode === 'microsoft' && domain) return { domain, microsoft: true, name: 'Microsoft account' };
  if (forcedMode === 'imap' && domain) return { domain, custom: true, name: domain };
  if (PROVIDERS[domain]) return { domain, ...PROVIDERS[domain] };
  if (!domain) return null;
  if (detectedMs[domain]) return { domain, microsoft: true, name: 'Microsoft 365 (' + domain + ')' };
  return { domain, custom: true, name: domain }; // business / custom mailbox
}
let forcedMode = null;       // user override: 'microsoft' | 'imap' | null
const detectedMs = {};       // domain -> true when Microsoft 365 is detected
let detectSeq = 0;

// For a custom domain, ask Microsoft whether it's a 365 tenant, then adapt.
async function autoDetectMicrosoft() {
  const email = $('#cEmail').value.trim();
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (!domain || !/\./.test(domain) || PROVIDERS[domain] || forcedMode) return;
  if (detectedMs[domain] !== undefined) return;
  const seq = ++detectSeq;
  const r = await window.mail.detectMailProvider(email);
  if (seq !== detectSeq) return;            // user kept typing
  detectedMs[domain] = !!(r && r.microsoft);
  if ($('#cEmail').value.trim() === email) updateConnectUI();
}
let detectTimer = null;
function scheduleDetect() { clearTimeout(detectTimer); detectTimer = setTimeout(autoDetectMicrosoft, 450); }
function updateConnectUI() {
  const email = $('#cEmail').value.trim();
  const p = providerFor(email);
  const msField = $('#msField'), keyField = $('#keyField'), serverField = $('#serverField');
  const provName = $('#provName'), openBtn = $('#openAppPw'), connectBtn = $('#doConnect');
  const useMs = $('#useMicrosoft');
  useMs.style.display = 'none';
  if (!p) { msField.style.display = 'none'; keyField.style.display = 'block'; serverField.style.display = 'none'; connectBtn.style.display = ''; provName.textContent = ''; return; }
  if (p.microsoft) {
    msField.style.display = 'block'; keyField.style.display = 'none'; serverField.style.display = 'none';
    connectBtn.style.display = 'none'; // sign-in is its own button
    provName.textContent = p.name;
    return;
  }
  msField.style.display = 'none'; keyField.style.display = 'block'; connectBtn.style.display = '';
  if (p.custom) {
    provName.textContent = `We’ll connect ${p.name} automatically.`;
    $('#keyLabel').textContent = 'Password';
    openBtn.style.display = 'none';
    $('#keyHelp').textContent = 'Enter your mail password. If your provider uses app passwords, use one of those.';
    $('#cPass').placeholder = 'your mail password';
    serverField.style.display = 'block';
    useMs.style.display = 'block'; // custom domain might be a Microsoft 365 work account
  } else {
    provName.textContent = `${p.name} detected.`;
    $('#keyLabel').textContent = p.keyLabel;
    openBtn.style.display = 'block';
    openBtn.textContent = `Open ${p.name}’s app-password page →`;
    $('#keyHelp').textContent = p.help;
    $('#cPass').placeholder = p.ph;
    serverField.style.display = 'none';
  }
}

let lastDomain = '';
function connect(prefillEmail) {
  if (prefillEmail && typeof prefillEmail === 'string') $('#cEmail').value = prefillEmail;
  $('#cStatus').textContent = '';
  $('#cPass').value = '';
  forcedMode = null; lastDomain = '';
  updateConnectUI();
  scheduleDetect();
  $('#connect').classList.add('show');
  $('#cEmail').focus();
}
$('#cEmail').addEventListener('input', () => {
  const domain = ($('#cEmail').value.split('@')[1] || '').toLowerCase();
  if (domain !== lastDomain) { forcedMode = null; lastDomain = domain; } // new address → re-detect
  updateConnectUI();
  scheduleDetect();
});
$('#useMicrosoft').onclick = () => { forcedMode = 'microsoft'; updateConnectUI(); };
$('#usePassword').onclick = () => { forcedMode = 'imap'; updateConnectUI(); };
$('#closeConnect').onclick = () => $('#connect').classList.remove('show');
$('#openAppPw').onclick = () => {
  const email = $('#cEmail').value.trim();
  const p = providerFor(email);
  if (!p || !p.link) return;
  const url = p.link + (p.domain === 'gmail.com' || p.domain === 'googlemail.com' ? (email ? `?authuser=${encodeURIComponent(email)}` : '') : '');
  window.mail.openExternal(url);
};
$('#msSignIn').onclick = async () => {
  const email = $('#cEmail').value.trim();
  const link = $('#msLink').value.trim();
  $('#msSetupNote').style.display = 'none';
  $('#cStatus').style.color = '';
  $('#cStatus').innerHTML = '<span class="spin"></span> Opening Microsoft sign-in…';
  const r = await window.mail.connectMicrosoft(email, link);
  if (r.ok) {
    $('#cStatus').textContent = 'Connected.';
    $('#connect').classList.remove('show');
    $('#whoami').textContent = r.email; $('#whoami').classList.add('ok');
    refreshStatus();
  } else if (r.needsSetup) {
    $('#cStatus').textContent = '';
    $('#msSetupNote').style.display = 'block';
  } else {
    $('#cStatus').style.color = '#ff8a8a';
    $('#cStatus').textContent = r.error;
  }
};

$('#doConnect').onclick = async () => {
  const email = $('#cEmail').value.trim();
  const pass = $('#cPass').value;
  const host = $('#serverField').style.display !== 'none' ? $('#cHost').value.trim() : '';
  $('#cStatus').style.color = '';
  $('#cStatus').innerHTML = '<span class="spin"></span> Connecting…';
  const r = await window.mail.connectImap(email, pass, host || undefined);
  if (r.ok) {
    $('#cStatus').textContent = 'Connected.';
    $('#connect').classList.remove('show');
    $('#cPass').value = '';
    $('#whoami').textContent = r.email; $('#whoami').classList.add('ok');
    $('#connectBtn').textContent = 'Reconnect';
    loadInbox();
  } else {
    $('#cStatus').style.color = '#ff8a8a';
    $('#cStatus').textContent = r.error;
  }
};

// ---------- inbox ----------
async function loadInbox() {
  $('#list').innerHTML = '<div class="center muted"><span class="spin"></span> Loading your mail…</div>';
  const r = await window.mail.listInbox(30);
  if (!r.ok) { $('#list').innerHTML = `<div class="center muted">Couldn't load mail.<br>${r.error}</div>`; return; }
  messages = r.messages;
  $('#inboxCount').textContent = messages.filter((m) => m.unread).length || '';
  renderList(messages);
  fetchSnippets();
}

// Quiet background refresh: no spinner, keeps your place and selection.
let refreshing = false;
async function quietRefresh() {
  if (refreshing) return;
  const st = await window.mail.sessionStatus();
  if (!st.signedIn) return;
  refreshing = true;
  try {
    const r = await window.mail.listInbox(30);
    if (r.ok) {
      const openId = openMsg && openMsg.id;
      // carry over snippets we already fetched
      const prev = {}; for (const m of messages) prev[m.id] = m.snippet;
      messages = r.messages.map((m) => (prev[m.id] ? { ...m, snippet: prev[m.id] } : m));
      $('#inboxCount').textContent = messages.filter((m) => m.unread).length || '';
      if (!$('#search').value.trim()) {
        renderList(messages);
        if (openId) {
          const rows = [...el('.row')];
          const idx = messages.findIndex((m) => m.id === openId);
          if (idx >= 0 && rows[idx]) rows[idx].classList.add('on');
        }
      }
      fetchSnippets();
    }
  } finally { refreshing = false; }
}

// Fill in preview text after the list is shown, so the list appears instantly.
async function fetchSnippets() {
  const ids = messages.filter((m) => !m.snippet).map((m) => m.id).slice(0, 30);
  if (!ids.length) return;
  const r = await window.mail.getSnippets(ids);
  if (!r.ok) return;
  for (const m of messages) if (r.snippets[m.id]) m.snippet = r.snippets[m.id];
  // only re-render if the search box is empty (don't disturb a filtered view)
  if (!$('#search').value.trim()) renderList(messages);
}

function renderList(list) {
  const box = $('#list');
  if (!list.length) { box.innerHTML = '<div class="center muted">No messages.</div>'; return; }
  box.innerHTML = '';
  for (const m of list) {
    const d = document.createElement('div');
    d.className = 'row' + (m.unread ? ' unread' : '');
    const snip = m.snippet ? `<div class="snip">${esc(m.snippet)}</div>` : '';
    const clip = m.hasAttachments ? ' 📎' : '';
    d.innerHTML = `
      ${m.unread ? '<span class="dot"></span>' : ''}
      <div class="av" style="background:${avatarColor(m.from)}">${esc(initial(m.from))}</div>
      <div class="body">
        <div class="from"><span class="name">${esc(m.from)}</span><span class="date">${esc(m.dateLabel || '')}</span></div>
        <div class="subj">${esc(m.subject)}${clip}</div>${snip}
      </div>`;
    d.onclick = () => openMessage(m, d);
    box.appendChild(d);
  }
}

async function openMessage(m, node) {
  el('.row').forEach((r) => r.classList.remove('on'));
  node && node.classList.add('on');
  $('#reader').innerHTML = '<div class="center muted"><span class="spin"></span> Opening…</div>';
  const r = await window.mail.readMessage(m.id);
  const body = r.ok ? r.body : `Couldn't open this message.\n${r.error}`;
  const atts = (r.ok && r.attachments) || [];
  openMsg = { ...m, body };
  let attHtml = '';
  if (atts.length) {
    attHtml = '<div class="atts">' + atts.map((a) =>
      `<button class="att" data-i="${a.index}">${a.isPdf ? '📄' : '📎'} ${esc(a.name)}${a.size ? ` · ${fmtSize(a.size)}` : ''}</button>`
    ).join('') + '</div>';
  }
  $('#reader').innerHTML = `<div class="reader">
    <h2>${esc(m.subject)}</h2>
    <div class="senderrow">
      <div class="av" style="background:${avatarColor(m.from)}">${esc(initial(m.from))}</div>
      <div><div class="sname">${esc(m.from)}</div><div class="meta">${esc(m.dateLabel || '')}</div></div>
    </div>
    ${attHtml}
    <pre>${esc(body)}</pre></div>`;
  $('#reader').querySelectorAll('.att').forEach((b) => {
    b.onclick = () => window.mail.openAttachment(m.id, Number(b.dataset.i));
  });
  setMode('this');
}

// ---------- search ----------
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) return renderList(messages);
  renderList(messages.filter((m) => (m.from + ' ' + m.subject + ' ' + m.snippet).toLowerCase().includes(q)));
});
$('#refresh').onclick = loadInbox;
$('#connectBtn').onclick = () => connect();
document.getElementById('addMailbox').onclick = () => connect();

// ---------- chat ----------
el('.chip').forEach((c) => (c.onclick = () => setMode(c.dataset.mode)));
function setMode(m) {
  mode = m;
  $('#modeThis').classList.toggle('on', m === 'this');
  $('#modeAll').classList.toggle('on', m === 'all');
}

el('#quick button').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
$('#send').onclick = () => ask($('#ask').value);
$('#ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask($('#ask').value); });

function addBubble(cls, text) {
  const d = document.createElement('div');
  d.className = 'bubble ' + cls;
  d.textContent = text;
  $('#msgs').appendChild(d);
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
  return d;
}

async function ask(q) {
  q = (q || '').trim();
  if (!q) return;
  $('#ask').value = '';
  addBubble('me', q);

  // Build context from mail, right-sized so small local models cope.
  let context = '';
  if (mode === 'this' && openMsg) {
    context = `EMAIL\nFrom: ${openMsg.from}\nSubject: ${openMsg.subject}\nDate: ${openMsg.date}\n\n${openMsg.body}`;
  } else {
    // "all mail": find the most relevant messages, read the top few in full
    const terms = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored = messages.map((m) => {
      const hay = (m.from + ' ' + m.subject + ' ' + m.snippet).toLowerCase();
      return { m, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
    }).sort((a, b) => b.score - a.score);
    const picks = (scored[0].score > 0 ? scored.filter((x) => x.score > 0) : scored).slice(0, 6).map((x) => x.m);
    const bodies = [];
    for (const m of picks) {
      const r = await window.mail.readMessage(m.id);
      bodies.push(`--- From: ${m.from} | Subject: ${m.subject} | ${m.date}\n${(r.ok ? r.body : m.snippet).slice(0, 2500)}`);
    }
    context = `These are the emails most related to the question (read in full):\n\n${bodies.join('\n\n')}`;
  }

  let sysContent =
    'You are an email assistant. Answer ONLY from the emails provided. ' +
    'If the answer is not in them, say so plainly. Be short and concrete. ' +
    'When you name an email, quote its sender and subject so the person can find it.';
  if (prefs.instructions) sysContent += `\n\nThe user's own instructions (follow these):\n${prefs.instructions}`;
  if (prefs.keywords.length) sysContent += `\n\nPay special attention to anything about: ${prefs.keywords.join(', ')}.`;
  const sys = { role: 'system', content: sysContent };
  const user = { role: 'user', content: `${context}\n\nQUESTION: ${q}` };

  const bubble = addBubble('ai', '');
  bubble.innerHTML = '<span class="spin"></span>';
  let acc = '';
  const off = window.mail.onToken((t) => { acc += t; bubble.textContent = acc; $('#msgs').scrollTop = $('#msgs').scrollHeight; });
  const r = await window.mail.aiChat([sys, user]);
  if (!r.ok) bubble.textContent = '⚠ ' + r.error + '\n\nCheck Settings → AI provider.';
  else if (!acc) bubble.textContent = r.full || '(no reply)';
}

// ---------- settings ----------
const providerSel = $('#provider');
$('#openSettings').onclick = openSettings;
$('#closeSettings').onclick = () => $('#settings').classList.remove('show');
providerSel.onchange = syncProviderFields;

async function openSettings() {
  const s = await window.mail.getSettings();
  providerSel.value = s.provider || 'ollama';
  $('#keyState').textContent = s.hasKey ? '· saved (leave blank to keep)' : '';
  $('#baseUrl').value = s.baseUrl || '';
  $('#instructions').value = s.instructions || '';
  $('#keywords').value = (s.keywords || []).join(', ');
  $('#msClientId').value = s.msClientId || '';
  await syncProviderFields(s.model);
  $('#settings').classList.add('show');
}

async function syncProviderFields(presetModel) {
  const p = providerSel.value;
  const needsKey = p !== 'ollama';
  const needsBase = p === 'openai-compat';
  $('#keyField').style.display = needsKey ? '' : 'none';
  $('#baseField').style.display = needsBase ? '' : 'none';

  const sel = $('#modelSelect'), txt = $('#modelText');
  if (p === 'ollama') {
    const m = await window.mail.aiModels();
    sel.style.display = ''; txt.style.display = 'none';
    sel.innerHTML = (m.ollama.length ? m.ollama : ['(no local models — install one in Ollama)'])
      .map((n) => `<option>${n}</option>`).join('');
    if (presetModel && m.ollama.includes(presetModel)) sel.value = presetModel;
  } else {
    sel.style.display = 'none'; txt.style.display = '';
    const defaults = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5', deepseek: 'deepseek-chat', 'openai-compat': '' };
    txt.value = presetModel || defaults[p] || '';
  }
}

$('#saveSettings').onclick = async () => {
  const p = providerSel.value;
  const model = p === 'ollama' ? $('#modelSelect').value : $('#modelText').value.trim();
  // DeepSeek and "other" both ride the OpenAI-compatible route with a base URL.
  let provider = p, baseUrl = $('#baseUrl').value.trim();
  if (p === 'openai-compat') provider = 'openai';
  if (p === 'deepseek') { provider = 'openai'; baseUrl = 'https://api.deepseek.com'; }
  const keywords = $('#keywords').value.split(',').map((k) => k.trim()).filter(Boolean);
  await window.mail.saveSettings({
    provider,
    model,
    baseUrl,
    apiKey: $('#apiKey').value.trim(), // blank = keep existing
    instructions: $('#instructions').value.trim(),
    keywords,
    msClientId: $('#msClientId').value.trim(),
  });
  $('#apiKey').value = '';
  prefs.instructions = $('#instructions').value.trim();
  prefs.keywords = keywords;
  renderKeywordBar();
  $('#settings').classList.remove('show');
};

function esc(s) { return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function fmtSize(n) { if (!n) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

// ---------- resizable panes ----------
const PANE = {
  side: { var: '--w-side', min: 140, max: 340 },
  list: { var: '--w-list', min: 230, max: 560 },
  chat: { var: '--w-chat', min: 260, max: 620 },
};
function applySavedPaneSizes() {
  for (const key of Object.keys(PANE)) {
    const v = localStorage.getItem('pane-' + key);
    if (v) document.documentElement.style.setProperty(PANE[key].var, v + 'px');
  }
}
function setupGutters() {
  let active = null; // {spec, sign, startX, startW, key}
  const move = (ev) => {
    if (!active) return;
    let w = active.startW + active.sign * (ev.clientX - active.startX);
    w = Math.max(active.spec.min, Math.min(active.spec.max, w));
    document.documentElement.style.setProperty(active.spec.var, w + 'px');
  };
  const up = () => {
    if (!active) return;
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(active.spec.var));
    localStorage.setItem('pane-' + active.key, Math.round(w));
    document.querySelectorAll('.gutter').forEach((g) => g.classList.remove('dragging'));
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    active = null;
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  document.querySelectorAll('.gutter').forEach((g) => {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const key = g.dataset.target;
      const spec = PANE[key];
      active = {
        key, spec, sign: Number(g.dataset.sign), startX: e.clientX,
        startW: parseFloat(getComputedStyle(document.documentElement).getPropertyValue(spec.var)),
      };
      g.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
  });
}

// live refresh: the server pushes when new mail lands…
window.mail.onMailChanged(() => quietRefresh());
// …and a safety-net poll every 90s in case the push connection dropped.
setInterval(() => { if (messages.length) quietRefresh(); }, 90000);

// go
applySavedPaneSizes();
setupGutters();
refreshStatus();
loadPrefs();
