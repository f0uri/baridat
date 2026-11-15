import './style.css';

// ============================================================
// Native bridge
// ============================================================
const N = window.BaridatNative || null;

function nlog(level, msg) { try { N && N.log(level, String(msg)); } catch {} }
function nget(k, def)   { try { return N ? N.loadString(k, def) : def; } catch { return def; } }
function nset(k, v)     { try { if (N) N.storeString(k, v); } catch(e){ nlog('e','store '+k+' failed: '+e); } }
function nrm(k)         { try { if (N) N.removeKey(k); } catch {} }

// Promisified native HTTP — never uses fetch, never hits file:// CORS issues.
function http(method, url, body, token) {
  return new Promise((resolve) => {
    if (!N || !N.http) {
      // Fallback: no native bridge (dev in browser). Use fetch.
      fetch(url, {
        method,
        headers: Object.assign(
          { 'Accept': 'application/json' },
          body ? { 'Content-Type': 'application/json' } : {},
          token ? { 'Authorization': 'Bearer ' + token } : {},
        ),
        body: body || undefined,
      }).then(r => r.text().then(t => resolve({ ok: r.ok, status: r.status, body: t })))
        .catch(e => resolve({ ok: false, status: 0, error: String(e) }));
      return;
    }
    const cb = '_ncb_' + Math.random().toString(36).slice(2);
    window[cb] = function(res) {
      try { delete window[cb]; } catch {}
      try { resolve(JSON.parse(res)); } catch { resolve({ ok: false, status: 0, error: 'bad-json' }); }
    };
    try {
      N.http(method, url, body || null, token || null, cb);
    } catch (e) {
      resolve({ ok: false, status: 0, error: 'http-exc: ' + e });
    }
  });
}

// ============================================================
// Version
// ============================================================
let APP_VERSION = '0.0.0';
(function resolveVersion() {
  try {
    if (N && typeof N.getAppVersion === 'function') {
      const v = N.getAppVersion();
      if (v && /^\d+\.\d+\.\d+/.test(v)) { APP_VERSION = v; return; }
    }
  } catch {}
  // Fallback: xhr version.json (works on file://)
  try {
    const x = new XMLHttpRequest();
    x.open('GET', './version.json', false);
    x.send(null);
    if (x.status === 200 || x.status === 0) {
      const d = JSON.parse(x.responseText);
      if (d && d.version) APP_VERSION = d.version;
    }
  } catch {}
})();

// ============================================================
// State
// ============================================================
const KEY_ACCOUNTS = 'baridat_accounts_v2';
const KEY_CURRENT  = 'baridat_current_v2';
const KEY_CUSTOM   = 'baridat_custom_server_v1';

let accounts = [];
let current = null;
let customServer = '';
let activeProvider = 'mailtm';
let pollingTimer = null;

function $(id) { return document.getElementById(id); }
function rnd(n) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ============================================================
// Providers (both go through http() → native bridge)
// ============================================================
const PROVIDERS = {
  mailtm: {
    label: 'mail.tm',
    async create() {
      const doms = await http('GET', 'https://api.mail.tm/domains?page=1');
      if (!doms.ok) throw new Error('domains: HTTP ' + doms.status);
      const dd = JSON.parse(doms.body);
      const list = (dd['hydra:member'] || []).filter(d => d.isActive);
      if (!list.length) throw new Error('لا يوجد دومين نشط في mail.tm');
      const domain = list[0].domain;
      const address = rnd(12) + '@' + domain;
      const password = rnd(24);
      const cr = await http('POST', 'https://api.mail.tm/accounts',
        JSON.stringify({ address, password }));
      if (!cr.ok) throw new Error('create: HTTP ' + cr.status);
      const tr = await http('POST', 'https://api.mail.tm/token',
        JSON.stringify({ address, password }));
      if (!tr.ok) throw new Error('token: HTTP ' + tr.status);
      const tok = JSON.parse(tr.body);
      return { id: JSON.parse(cr.body).id, address, password, token: tok.token, provider: 'mailtm', domain };
    },
    async list(acc) {
      const r = await http('GET', 'https://api.mail.tm/messages?page=1', null, acc.token);
      if (!r.ok) throw new Error('list: HTTP ' + r.status);
      const d = JSON.parse(r.body);
      return (d['hydra:member'] || []).map(normalizeMailtm);
    },
    async read(acc, id) {
      const r = await http('GET', 'https://api.mail.tm/messages/' + id, null, acc.token);
      if (!r.ok) throw new Error('read: HTTP ' + r.status);
      return normalizeMailtm(JSON.parse(r.body), true);
    },
    async remove(acc, id) {
      await http('DELETE', 'https://api.mail.tm/messages/' + id, null, acc.token);
    },
  },
  mail123: {
    label: 'mail123',
    async create() {
      const r = await http('GET', 'https://mail123.fr/api/v1/mailbox/new');
      if (!r.ok) throw new Error('mail123 new: HTTP ' + r.status);
      const d = JSON.parse(r.body);
      if (!d.success) throw new Error('mail123 refused new');
      return { id: d.box + '@' + d.domain, address: d.address, password: '', token: '', provider: 'mail123', domain: d.domain, box: d.box };
    },
    async list(acc) {
      const r = await http('GET', 'https://mail123.fr/api/v1/mailbox/' + encodeURIComponent(acc.address) + '/messages');
      if (!r.ok) { if (r.status === 429) throw new Error('rate-limit'); throw new Error('list: HTTP ' + r.status); }
      const d = JSON.parse(r.body);
      if (!d.success) throw new Error(d.error || 'list failed');
      return (d.messages || []).map(normalizeMail123);
    },
    async read(acc, id) {
      const r = await http('GET', 'https://mail123.fr/api/v1/mailbox/' + encodeURIComponent(acc.address) + '/messages/' + encodeURIComponent(id));
      if (!r.ok) throw new Error('read: HTTP ' + r.status);
      const d = JSON.parse(r.body);
      return normalizeMail123(d.message || d, true);
    },
    async remove(acc, id) {
      await http('DELETE', 'https://mail123.fr/api/v1/mailbox/' + encodeURIComponent(acc.address) + '/messages/' + encodeURIComponent(id));
    },
  },
};

function normalizeMailtm(m, full = false) {
  const from = (m.from && (Array.isArray(m.from) ? m.from[0] : m.from)) || {};
  return {
    id: m.id,
    fromName: from.name || '',
    fromAddr: from.address || '',
    subject: m.subject || '(بدون موضوع)',
    intro: m.intro || (m.text ? m.text.slice(0, 120) : ''),
    text: full ? (m.text || '') : '',
    html: full ? (m.html || '') : '',
    seen: !!m.seen,
    createdAt: m.createdAt,
  };
}
function normalizeMail123(m, full = false) {
  const from = m.from || m.sender || {};
  return {
    id: m.id || m.uid || m._id || m.message_id,
    fromName: from.name || from.address_name || '',
    fromAddr: from.address || from.mail || m.from_address || '',
    subject: m.subject || m.title || '(بدون موضوع)',
    intro: m.preview || m.intro || (m.text || m.body_text || '').slice(0, 120),
    text: full ? (m.text || m.body_text || '') : '',
    html: full ? (m.html || m.body_html || '') : '',
    seen: !!m.seen || !!m.read,
    createdAt: m.created_at || m.createdAt || m.date || m.received_at,
  };
}

async function tryCreate() {
  const order = customServer ? [] : ['mailtm', 'mail123'];
  let lastErr = null;
  for (const pid of order) {
    try {
      const a = await PROVIDERS[pid].create();
      activeProvider = pid;
      return a;
    } catch (e) {
      lastErr = e;
      nlog('warn', 'provider ' + pid + ' failed: ' + e.message);
    }
  }
  throw lastErr || new Error('كل المزودين فشلوا');
}

// ============================================================
// Storage
// ============================================================
function saveAccounts() {
  const j = JSON.stringify(accounts);
  localStorage.setItem(KEY_ACCOUNTS, j);
  nset(KEY_ACCOUNTS, j);
}
function saveCurrent() {
  const id = current ? current.id : '';
  localStorage.setItem(KEY_CURRENT, id);
  nset(KEY_CURRENT, id);
}
function saveCustom() {
  localStorage.setItem(KEY_CUSTOM, customServer);
  nset(KEY_CUSTOM, customServer);
}
function loadState() {
  // v1 → v2 migration
  const oldAcc = localStorage.getItem('baridat_accounts_v1');
  if (oldAcc && !localStorage.getItem(KEY_ACCOUNTS)) {
    localStorage.setItem(KEY_ACCOUNTS, oldAcc);
    nset(KEY_ACCOUNTS, oldAcc);
  }
  const oldCur = localStorage.getItem('baridat_current_v1');
  if (oldCur && !localStorage.getItem(KEY_CURRENT)) {
    localStorage.setItem(KEY_CURRENT, oldCur);
    nset(KEY_CURRENT, oldCur);
  }
  // prefer native
  let raw = nget(KEY_ACCOUNTS, '');
  if (!raw) raw = localStorage.getItem(KEY_ACCOUNTS) || '';
  try { accounts = raw ? JSON.parse(raw) : []; } catch { accounts = []; }
  let curId = nget(KEY_CURRENT, '');
  if (!curId) curId = localStorage.getItem(KEY_CURRENT) || '';
  current = (curId && accounts.find(a => a.id === curId)) || accounts[0] || null;
  customServer = nget(KEY_CUSTOM, '') || localStorage.getItem(KEY_CUSTOM) || '';
}

// ============================================================
// Rendering
// ============================================================
function fmtDate(s) {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return 'الآن';
    if (diff < 3600) return Math.floor(diff / 60) + ' د';
    if (diff < 86400) return Math.floor(diff / 3600) + ' س';
    return d.toLocaleDateString('ar-EG');
  } catch { return ''; }
}

function render() {
  // Version badge
  $('versionBadge').textContent = 'v' + APP_VERSION;
  const sv = $('settingsVersion'); if (sv) sv.textContent = APP_VERSION;

  // Provider
  $('providerLabel').textContent = customServer ? 'خادم خاص' : PROVIDERS[activeProvider]?.label || '…';

  // Current address
  const ca = $('currentAddress');
  if (current) ca.textContent = current.address;
  else ca.textContent = 'جاري إنشاء بريد…';

  // Address list in drawer
  const list = $('addressList');
  list.innerHTML = '';
  accounts.forEach(a => {
    const it = document.createElement('div');
    it.className = 'addr-item' + (current && a.id === current.id ? ' active' : '');
    it.textContent = a.address;
    it.onclick = () => { switchTo(a.id); closeDrawer(); };
    list.appendChild(it);
  });

  // Input
  $('customServer').value = customServer;
}

function renderMessages(list) {
  const box = $('messages');
  box.innerHTML = '';
  const empty = $('emptyMsg');
  if (!list || list.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;
  list.forEach(m => {
    const el = document.createElement('div');
    el.className = 'msg' + (m.seen ? '' : ' unread');
    const initial = (m.fromName || m.fromAddr || '?').trim().charAt(0).toUpperCase() || '?';
    const dot = m.seen ? '' : '<div class="msg-dot"></div>';
    el.innerHTML = `
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="msg-body">
        <div class="msg-top">
          <div class="msg-from">${escapeHtml(m.fromName || m.fromAddr || 'مجهول')}</div>
          <div class="msg-time">${fmtDate(m.createdAt)}</div>
        </div>
        <div class="msg-subject">${escapeHtml(m.subject)}</div>
      </div>
      ${dot}
    `;
    el.onclick = () => openMessage(m.id);
    box.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ============================================================
// Drawer
// ============================================================
function openDrawer()  { $('drawer').classList.add('open'); $('scrim').classList.add('show'); $('scrim').hidden = false; }
function closeDrawer() { $('drawer').classList.remove('open'); $('scrim').classList.remove('show'); $('scrim').hidden = true; }

// ============================================================
// Messages flow
// ============================================================
async function createNewAddress() {
  hideAddressError();
  try {
    toast('جاري إنشاء عنوان…');
    const a = await tryCreate();
    accounts.unshift(a);
    current = a;
    saveAccounts(); saveCurrent();
    render();
    await refreshMessages();
    startPolling();
    toast('تم إنشاء العنوان');
  } catch (e) {
    nlog('error', 'create failed: ' + e.message);
    showAddressError('تعذر إنشاء بريد: ' + (e.message || e));
  }
}

function switchTo(id) {
  current = accounts.find(a => a.id === id) || current;
  saveCurrent();
  render();
  refreshMessages();
  startPolling();
}

async function refreshMessages() {
  if (!current) return;
  const prov = PROVIDERS[current.provider];
  if (!prov) return;
  try {
    const list = await prov.list(current);
    renderMessages(list);
  } catch (e) {
    nlog('warn', 'list failed: ' + e.message);
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(refreshMessages, 15000);
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm('حذف هذا العنوان؟')) return;
  accounts = accounts.filter(a => a.id !== current.id);
  current = accounts[0] || null;
  saveAccounts(); saveCurrent();
  render();
  renderMessages([]);
  if (!current) await createNewAddress();
  else refreshMessages();
}

// ============================================================
// Message modal
// ============================================================
let openMsgId = null;
async function openMessage(id) {
  if (!current) return;
  const prov = PROVIDERS[current.provider];
  openMsgId = id;
  try {
    const m = await prov.read(current, id);
    $('mSubject').textContent = m.subject;
    $('mFrom').textContent = (m.fromName ? m.fromName + ' <' + m.fromAddr + '>' : m.fromAddr) || '—';
    $('mDate').textContent = fmtDate(m.createdAt);
    // OTP detection
    const text = (m.subject + ' ' + m.text + ' ' + stripHtml(m.html)).replace(/\s+/g, ' ');
    const otpMatch = text.match(/\b(\d{4,8})\b/);
    const ob = $('mOtpBox');
    if (otpMatch) {
      ob.hidden = false;
      ob.textContent = otpMatch[1];
      ob.onclick = () => { copy(otpMatch[1]); toast('تم نسخ الكود'); };
    } else { ob.hidden = true; ob.textContent = ''; }
    // Body (iframe if html, else text)
    const body = $('mBody');
    if (m.html && m.html.trim()) {
      body.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.sandbox = '';
      iframe.srcdoc = sanitizeHtml(m.html);
      body.appendChild(iframe);
    } else {
      body.textContent = m.text || '(لا يوجد محتوى)';
    }
    $('msgModal').hidden = false;
    // Mark seen — just re-render list
    refreshMessages();
  } catch (e) {
    nlog('error', 'openMessage failed: ' + e.message);
    toast('تعذر فتح الرسالة');
  }
}
function closeMessage() { $('msgModal').hidden = true; openMsgId = null; }

async function deleteMsg() {
  if (!current || !openMsgId) return;
  const prov = PROVIDERS[current.provider];
  try { await prov.remove(current, openMsgId); closeMessage(); refreshMessages(); toast('تم الحذف'); }
  catch (e) { toast('فشل الحذف'); }
}

function stripHtml(h) { return h.replace(/<[^>]+>/g, ' '); }
function sanitizeHtml(h) {
  return String(h)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, 'blocked:');
}

// ============================================================
// Settings
// ============================================================
function openSettings() { $('settingsModal').hidden = false; }
function closeSettings() { $('settingsModal').hidden = true; }
function saveSettings() {
  customServer = $('customServer').value.trim();
  saveCustom();
  render();
  closeSettings();
  toast('تم الحفظ');
}

// ============================================================
// Utils
// ============================================================
function copy(s) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  } catch {}
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}
function showAddressError(msg) {
  const e = $('addressError'); e.textContent = msg; e.hidden = false;
}
function hideAddressError() { $('addressError').hidden = true; }

// ============================================================
// Init
// ============================================================
function bind() {
  $('menuBtn').onclick = openDrawer;
  $('scrim').onclick = closeDrawer;
  $('newAddressBtn').onclick = () => { closeDrawer(); createNewAddress(); };
  $('settingsBtn').onclick = () => { closeDrawer(); openSettings(); };
  $('refreshBtn').onclick = () => refreshMessages();
  $('copyBtn').onclick = () => { if (current) { copy(current.address); toast('تم النسخ'); } };
  $('refreshAddressBtn').onclick = refreshMessages;
  $('deleteAddressBtn').onclick = deleteCurrent;
  $('closeModal').onclick = closeMessage;
  $('deleteMsgBtn').onclick = deleteMsg;
  $('closeSettings').onclick = closeSettings;
  $('saveSettings').onclick = saveSettings;
}

async function boot() {
  bind();
  loadState();
  render();
  if (current) {
    await refreshMessages();
    startPolling();
  } else {
    await createNewAddress();
  }
  nlog('info', 'baridat booted v' + APP_VERSION);
}

boot();
