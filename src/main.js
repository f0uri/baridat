import './style.css';

// ======= Native bridge =======
const Native = window.BaridatNative || null;

function nativeGet(key, def) {
  try { return Native ? Native.loadString(key, def) : def; } catch { return def; }
}
function nativeSet(key, val) {
  try { if (Native) Native.storeString(key, val); } catch {}
}
function nativeRemove(key) {
  try { if (Native) Native.removeKey(key); } catch {}
}

// ======= Version =======
let APP_VERSION = '0.0.0';
(async function resolveVersion() {
  // Prefer native (Kotlin BuildConfig) over anything else
  if (Native && Native.getAppVersion) {
    APP_VERSION = Native.getAppVersion();
    return;
  }
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.version) APP_VERSION = data.version;
    }
  } catch {}
})();

// ======= Providers =======
const PROVIDERS = {
  mailtm: {
    id: 'mailtm', label: 'mail.tm',
    base: 'https://api.mail.tm',
    async create() {
      const domRes = await fetch(`${this.base}/domains?page=1`);
      if (!domRes.ok) throw new Error(`domains HTTP ${domRes.status}`);
      const domData = await domRes.json();
      const domains = (domData['hydra:member'] || []).filter(d => d.isActive);
      if (!domains.length) throw new Error('لا يوجد دومين نشط على mail.tm');
      const domain = domains[0].domain;
      const address = rnd(12) + '@' + domain;
      const password = rnd(24);
      const accRes = await fetch(`${this.base}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (!accRes.ok) throw new Error(`create HTTP ${accRes.status}`);
      const acc = await accRes.json();
      const tokRes = await fetch(`${this.base}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (!tokRes.ok) throw new Error(`token HTTP ${tokRes.status}`);
      const tok = await tokRes.json();
      return {
        id: acc.id, address: acc.address, password, token: tok.token,
        provider: this.id, createdAt: Date.now(), extra: { domain },
      };
    },
    async list(acc) {
      const res = await fetch(`${this.base}/messages?page=1`, {
        headers: { Authorization: `Bearer ${acc.token}` },
      });
      if (!res.ok) throw new Error(`list HTTP ${res.status}`);
      const d = await res.json();
      return (d['hydra:member'] || []).map(m => this._normalize(m));
    },
    async read(acc, id) {
      const res = await fetch(`${this.base}/messages/${id}`, {
        headers: { Authorization: `Bearer ${acc.token}` },
      });
      if (!res.ok) throw new Error(`read HTTP ${res.status}`);
      return this._normalize(await res.json(), true);
    },
    async remove(acc, id) {
      await fetch(`${this.base}/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${acc.token}` },
      });
    },
    _normalize(m, full = false) {
      const from = (m.from && (Array.isArray(m.from) ? m.from[0] : m.from)) || {};
      const toArr = Array.isArray(m.to) ? m.to : (m.to ? [m.to] : []);
      return {
        id: m.id,
        from: { name: from.name || '', address: from.address || '' },
        to: toArr.map(t => ({ name: t.name || '', address: t.address || '' })),
        subject: m.subject || '',
        intro: (m.intro || (m.text ? m.text.slice(0, 120) : '')) + (full ? '' : ''),
        text: full ? m.text || '' : '',
        html: full ? m.html || '' : '',
        seen: !!m.seen,
        createdAt: m.createdAt,
        attachments: (m.attachments || []).map(a => ({
          id: a.id, filename: a.filename, size: a.size,
          url: `${this.base}/messages/${m.id}/attachment/${a.filename}?token=__TOK__`,
        })),
      };
    },
  },

  mail123: {
    id: 'mail123', label: 'mail123',
    base: 'https://mail123.fr/api/v1',
    async create() {
      const res = await fetch(`${this.base}/mailbox/new`);
      if (!res.ok) throw new Error(`mail123 new HTTP ${res.status}`);
      const d = await res.json();
      if (!d.success) throw new Error('mail123 refused new mailbox');
      this.lastDomains = d.available_domains || [d.domain];
      return {
        id: d.box + '@' + d.domain,
        address: d.address,
        password: '',
        token: '',
        provider: this.id,
        createdAt: Date.now(),
        extra: { box: d.box, domain: d.domain, domains: d.available_domains },
      };
    },
    async list(acc) {
      const res = await fetch(`${this.base}/mailbox/${encodeURIComponent(acc.address)}/messages`);
      if (!res.ok) {
        if (res.status === 429) throw new Error('RATE_LIMIT');
        throw new Error(`mail123 list HTTP ${res.status}`);
      }
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'mail123 list failed');
      return (d.messages || []).map(m => this._normalize(m));
    },
    async read(acc, id) {
      const res = await fetch(`${this.base}/mailbox/${encodeURIComponent(acc.address)}/messages/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`mail123 read HTTP ${res.status}`);
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'mail123 read failed');
      return this._normalize(d.message || d, true);
    },
    async remove(acc, id) {
      await fetch(`${this.base}/mailbox/${encodeURIComponent(acc.address)}/messages/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    _normalize(m, full = false) {
      const from = m.from || m.sender || {};
      const fromName = from.name || from.address_name || '';
      const fromAddr = from.address || from.mail || m.from_address || '';
      const subj = m.subject || m.title || '';
      const bodyHtml = m.html || m.body_html || m.bodyHtml || '';
      const bodyText = m.text || m.body_text || m.bodyText || m.preview || m.intro || '';
      return {
        id: m.id || m.uid || m._id || m.message_id,
        from: { name: fromName, address: fromAddr },
        to: [{ name: '', address: m.to || m.recipient || '' }],
        subject: subj,
        intro: (m.preview || m.intro || bodyText.slice(0, 120)),
        text: full ? bodyText : '',
        html: full ? bodyHtml : '',
        seen: !!m.seen || !!m.read,
        createdAt: m.created_at || m.createdAt || m.date || m.received_at,
        attachments: (m.attachments || []).map(a => ({
          id: a.id || a.filename, filename: a.filename || a.name, size: a.size || 0, url: a.url || '',
        })),
      };
    },
  },
};

// ======= Storage keys =======
const STORAGE_KEY = 'baridat_accounts_v2';
const CURRENT_KEY = 'baridat_current_v2';
const CUSTOM_SERVER_KEY = 'baridat_custom_server_v1';
const LEGACY_STORAGE_KEY = 'baridat_accounts_v1';
const LEGACY_CURRENT_KEY = 'baridat_current_v1';

// ======= State =======
let accounts = [];
let currentAccount = null;
let messages = [];
let pollTimer = null;
let activeProvider = 'mailtm';
let customServer = '';
let refreshActive = false;
let lastRefresh = 0;

// ======= DOM =======
const $ = (id) => document.getElementById(id);

// ======= Utilities =======
function showToast(msg, duration = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), duration);
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function rnd(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  (crypto.getRandomValues ? crypto : window.crypto).getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (isNaN(diff)) return '';
  if (diff < 60) return 'الآن';
  if (diff < 3600) return Math.floor(diff/60) + 'د';
  if (diff < 86400) return Math.floor(diff/3600) + 'س';
  if (diff < 604800) return Math.floor(diff/86400) + 'ي';
  return d.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes) return '0B';
  const u = ['B','KB','MB','GB']; let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + u[i];
}

function otpExtract(text) {
  if (!text) return null;
  // 4-8 digit OTP
  const m = String(text).replace(/<[^>]+>/g, ' ').match(/(?<!\d)(\d{4,8})(?!\d)/);
  return m ? m[1] : null;
}

// ======= Persistence =======
function loadAccounts() {
  // Try native (SharedPreferences) first, fall back to localStorage, then legacy
  let raw = nativeGet(STORAGE_KEY, '');
  if (!raw) raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || '';
  try { accounts = raw ? JSON.parse(raw) : []; } catch { accounts = []; }

  const curId = nativeGet(CURRENT_KEY, '') || localStorage.getItem(CURRENT_KEY) || localStorage.getItem(LEGACY_CURRENT_KEY);
  currentAccount = (curId && accounts.find(a => a.id === curId)) || accounts[0] || null;

  customServer = nativeGet(CUSTOM_SERVER_KEY, '') || localStorage.getItem(CUSTOM_SERVER_KEY) || '';

  // Choose active provider: custom > mailtm (default)
  // We attempt mail.tm first at runtime; if it fails on create, switch to mail123.
  activeProvider = currentAccount?.provider || 'mailtm';

  // Migrate legacy entries if any
  if (localStorage.getItem(LEGACY_STORAGE_KEY) && !localStorage.getItem(STORAGE_KEY)) {
    saveAccounts();
    saveCurrent();
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_CURRENT_KEY);
  }
}

function saveAccounts() {
  const json = JSON.stringify(accounts);
  localStorage.setItem(STORAGE_KEY, json);
  nativeSet(STORAGE_KEY, json);
}
function saveCurrent() {
  if (currentAccount) {
    localStorage.setItem(CURRENT_KEY, currentAccount.id);
    nativeSet(CURRENT_KEY, currentAccount.id);
  } else {
    localStorage.removeItem(CURRENT_KEY);
    nativeRemove(CURRENT_KEY);
  }
}
function saveCustomServer() {
  localStorage.setItem(CUSTOM_SERVER_KEY, customServer);
  nativeSet(CUSTOM_SERVER_KEY, customServer);
}

// ======= Provider selection / API =======
function getProvider() {
  // For now, try the saved provider, fallback to mailtm then mail123 on error
  if (customServer) {
    // Custom server — use a minimal same-shape wrapper (future BillionMail)
    // We do NOT claim it works; just allow the field to be stored & shown.
    // Fall through to mail.tm if no custom server set.
  }
  return PROVIDERS[activeProvider] || PROVIDERS.mailtm;
}

async function tryCreateAccount(preferredProvider) {
  const order = preferredProvider
    ? [preferredProvider, 'mail123', 'mailtm'].filter((v,i,a) => a.indexOf(v) === i)
    : ['mailtm', 'mail123'];

  let lastErr = null;
  for (const pid of order) {
    const prov = PROVIDERS[pid];
    if (!prov) continue;
    try {
      const acc = await prov.create();
      activeProvider = pid;
      return acc;
    } catch (e) {
      lastErr = e;
      console.warn('[baridat] provider', pid, 'create failed:', e);
    }
  }
  throw lastErr || new Error('جميع المزودين فشلوا');
}

// ======= Accounts =======
async function createAccount() {
  setRefreshing(true, 'جاري إنشاء بريد جديد…');
  hideError();
  try {
    const newAcc = await tryCreateAccount();
    accounts.unshift(newAcc);
    currentAccount = newAcc;
    saveAccounts();
    saveCurrent();
    render();
    await refreshMessages();
    startPolling();
    showToast('تم إنشاء بريد جديد');
  } catch (e) {
    console.error(e);
    showError('تعذر إنشاء بريد', e.message || String(e));
  } finally {
    setRefreshing(false);
  }
}

function switchAccount(id) {
  currentAccount = accounts.find(a => a.id === id);
  saveCurrent();
  closeSidebar();
  render();
  refreshMessages();
}

async function deleteAccount(id) {
  if (!confirm('هل تريد حذف هذا البريد؟')) return;
  accounts = accounts.filter(a => a.id !== id);
  if (currentAccount?.id === id) currentAccount = accounts[0] || null;
  saveAccounts();
  saveCurrent();
  messages = [];
  render();
  if (currentAccount) await refreshMessages();
  showToast('تم حذف البريد');
}

// ======= Messages =======
async function fetchMessages() {
  if (!currentAccount) return [];
  const prov = PROVIDERS[currentAccount.provider];
  if (!prov) return [];
  return await prov.list(currentAccount);
}

async function fetchMessage(id) {
  if (!currentAccount) return null;
  const prov = PROVIDERS[currentAccount.provider];
  return await prov.read(currentAccount, id);
}

async function deleteMessage(id) {
  if (!currentAccount) return;
  const prov = PROVIDERS[currentAccount.provider];
  try { await prov.remove(currentAccount, id); } catch(e) { console.warn(e); }
  messages = messages.filter(m => m.id !== id);
  renderMessages();
  showToast('تم حذف الرسالة');
}

async function refreshMessages() {
  if (!currentAccount) { messages = []; renderMessages(); return; }
  setRefreshing(true, 'جاري التحديث…');
  hideError();
  try {
    const fresh = await fetchMessages();
    const prevIds = new Set(messages.map(m => m.id));
    const newOnes = fresh.filter(m => !prevIds.has(m.id));
    messages = fresh;
    renderMessages();
    renderEmailList();
    if (newOnes.length && lastRefresh) showToast('وصلت رسالة جديدة');
    lastRefresh = Date.now();
  } catch (e) {
    console.error(e);
    if (e.message === 'RATE_LIMIT') {
      showToast('الرجاء الانتظار قليلاً');
    } else {
      showError('تعذر جلب الرسائل', e.message || String(e));
    }
  } finally {
    setRefreshing(false);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshMessages, 15000);
}

// ======= Render =======
function render() {
  renderCurrent();
  renderEmailList();
  renderProvider();
  renderMessages();
  renderVersion();
  renderSettings();
}

function renderVersion() {
  $('versionBadge').textContent = 'v' + APP_VERSION;
  const sv = $('settingsVersion'); if (sv) sv.textContent = 'الإصدار ' + APP_VERSION;
}

function renderProvider() {
  const label = customServer ? 'الخادم الخاص' : getProvider().label;
  $('providerBadge').textContent = label;
  const ap = $('activeProvider'); if (ap) ap.textContent = label;
}

function renderCurrent() {
  const el = $('currentAddress');
  if (currentAccount) {
    el.textContent = currentAccount.address;
  } else {
    el.textContent = 'جاري إنشاء بريد…';
  }
}

function renderEmailList() {
  const list = $('emailList');
  list.innerHTML = '';
  if (!accounts.length) {
    const div = document.createElement('div');
    div.className = 'email-list-empty';
    div.textContent = 'لا توجد صناديق بعد';
    list.appendChild(div);
    return;
  }
  accounts.forEach(acc => {
    const el = document.createElement('div');
    el.className = 'email-item' + (currentAccount?.id === acc.id ? ' active' : '');
    const dt = new Date(acc.createdAt);
    const dateStr = dt.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit' });
    const unread = (messages.length && currentAccount?.id === acc.id) ? messages.filter(m => !m.seen).length : 0;
    const provLabel = PROVIDERS[acc.provider]?.label || '';
    el.innerHTML = `
      <div class="addr" dir="ltr">${escapeHtml(acc.address)}</div>
      <div class="meta">
        <span>${dateStr} · ${escapeHtml(provLabel)}</span>
        ${unread ? `<span class="count-badge">${unread}</span>` : ''}
      </div>
    `;
    let tapTimer = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del-x')) return;
      switchAccount(acc.id);
    });
    el.addEventListener('dblclick', () => deleteAccount(acc.id));
    list.appendChild(el);
  });
}

function renderMessages() {
  const list = $('messagesList');
  list.innerHTML = '';
  const empty = $('emptyState');
  const errState = $('errorState');

  if (errState.hidden === false) { list.style.display = 'none'; return; }

  if (!currentAccount) {
    empty.hidden = false; list.style.display = 'none'; return;
  }
  if (!messages.length) {
    empty.hidden = false; list.style.display = 'none';
    $('mailCount').textContent = '';
    return;
  }
  empty.hidden = true;
  list.style.display = 'flex';
  $('mailCount').textContent = messages.length + ' رسالة';

  messages.forEach(m => {
    const el = document.createElement('div');
    el.className = 'message-item' + (!m.seen ? ' unread' : '');
    const fromName = m.from?.name || (m.from?.address ? m.from.address.split('@')[0] : 'مجهول');
    const initial = (fromName.charAt(0) || '?').toUpperCase();
    const time = timeAgo(m.createdAt);
    el.innerHTML = `
      <div class="message-avatar">${escapeHtml(initial)}</div>
      <div class="message-content">
        <div class="message-from-line">
          <span class="message-from" dir="auto">${escapeHtml(fromName)} ${m.from?.address && m.from.name ? `<span>&lt;${escapeHtml(m.from.address)}&gt;</span>` : ''}</span>
          <span class="message-time">${escapeHtml(time)}</span>
        </div>
        <div class="message-subject">${escapeHtml(m.subject || '(بدون موضوع)')}</div>
        <div class="message-preview">${escapeHtml(m.intro || '—')}</div>
      </div>
      ${!m.seen ? '<div class="unread-dot"></div>' : ''}
    `;
    el.addEventListener('click', () => openMessage(m.id, el));
    list.appendChild(el);
  });
}

function setRefreshing(on, text) {
  refreshActive = on;
  const ind = $('refreshIndicator');
  if (on) { ind.hidden = false; $('refreshText').textContent = text || 'جاري التحديث…'; }
  else { ind.hidden = true; }
}

function showError(title, msg) {
  $('errorState').hidden = false;
  $('errorTitle').textContent = title;
  $('errorText').textContent = msg;
  $('emptyState').hidden = true;
  document.getElementById('messagesList').style.display = 'none';
}
function hideError() {
  $('errorState').hidden = true;
}

// ======= Message modal =======
let openMsgId = null;
async function openMessage(id, listEl) {
  try {
    const full = await fetchMessage(id);
    if (!full) return;
    openMsgId = id;
    if (!full.seen && listEl) {
      listEl.classList.remove('unread');
      const dot = listEl.querySelector('.unread-dot'); if (dot) dot.remove();
      full.seen = true;
    }
    $('modalSubject').textContent = full.subject || '(بدون موضوع)';
    const fromAddr = full.from?.address || '';
    const fromDisplay = [full.from?.name, fromAddr].filter(Boolean).join(' ');
    $('modalFrom').textContent = fromDisplay || '—';
    $('modalTo').textContent = (full.to || []).map(t => t.address).filter(Boolean).join(', ') || '—';
    $('modalDate').textContent = full.createdAt ? new Date(full.createdAt).toLocaleString('ar-EG') : '—';

    // OTP
    const bodyText = full.text || '';
    const bodyHtml = full.html || '';
    const code = otpExtract(bodyText + ' ' + (full.subject || '')) || otpExtract(stripHtml(bodyHtml));
    const otpBox = $('otpBox');
    if (code) {
      otpBox.hidden = false;
      $('otpCode').textContent = code;
      $('otpCode').onclick = () => { navigator.clipboard.writeText(code).then(() => showToast('تم نسخ الرمز')); };
    } else {
      otpBox.hidden = true;
    }

    // Attachments
    const attBox = $('modalAttachments');
    attBox.innerHTML = '';
    (full.attachments || []).forEach(a => {
      const ael = document.createElement('span');
      ael.className = 'attachment';
      ael.textContent = `${a.filename} (${formatSize(a.size)})`;
      attBox.appendChild(ael);
    });

    // Body
    const iframe = $('modalIframe');
    const safeHtml = sanitizeHtml(full.html) || '';
    const textHtml = full.text ? `<pre style="font-family:inherit;padding:20px;white-space:pre-wrap;color:#f5efe0;line-height:1.7;font-size:14px;direction:ltr;text-align:left;unicode-bidi:plaintext">${escapeHtml(full.text)}</pre>` : '';
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:0;font-family:Cairo,system-ui,sans-serif;color:#f5efe0;background:#0a0612;font-size:14px;line-height:1.7;padding:20px;word-break:break-word;direction:rtl;}
      a{color:#F4D26A;}
      img{max-width:100%;height:auto;border-radius:8px;}
      blockquote{border-right:3px solid #D4AF37;margin:12px 0;padding:8px 16px;color:#c9bfad;}
      pre{direction:ltr;text-align:left;white-space:pre-wrap;}
      table{border-collapse:collapse;width:100%;}
      td,th{border:1px solid #333;padding:6px;}
    </style></head><body>${safeHtml || textHtml || '<p style="color:#7f7567">لا محتوى</p>'}</body></html>`;
    iframe.srcdoc = doc;
    $('messageModal').hidden = false;
  } catch (e) {
    showToast('تعذر فتح الرسالة: ' + e.message);
  }
}

function stripHtml(s) { return s ? s.replace(/<[^>]*>/g, ' ') : ''; }

function sanitizeHtml(html) {
  if (!html) return '';
  // Strip dangerous tags/attrs: script, iframe (other than our own), event handlers, javascript: urls
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

// ======= Sidebar =======
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebarScrim').hidden = false;
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebarScrim').hidden = true;
}

// ======= Copy =======
async function copyEmail() {
  if (!currentAccount) { showToast('لا يوجد بريد حالياً'); return; }
  try {
    await navigator.clipboard.writeText(currentAccount.address);
    showToast('تم نسخ البريد');
    const btn = $('copyBtn'); btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1400);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = currentAccount.address; document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('تم نسخ البريد'); } catch {}
    document.body.removeChild(ta);
  }
}

// ======= OTA =======
async function checkUpdate() {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION && data.versionCode > (parseInt(APP_VERSION.split('.').join('')) || 0)) {
      $('updateBanner').hidden = false;
      $('updateMessage').textContent = `يتوفر إصدار جديد ${data.version}`;
      $('updateBtn').onclick = () => {
        if (/android/i.test(navigator.userAgent)) window.location.href = data.apkUrl || 'https://github.com/f0uri/baridat/releases/latest';
        else window.location.reload();
      };
    }
  } catch {}
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          $('updateBanner').hidden = false;
          $('updateMessage').textContent = 'يتوفر تحديث للتطبيق';
          $('updateBtn').onclick = () => {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            else window.location.reload();
          };
        }
      });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return; refreshing = true; window.location.reload();
    });
  } catch (e) { console.warn('SW', e); }
}

// ======= Settings =======
function renderSettings() {
  const inp = $('customServer'); if (inp) inp.value = customServer;
}
function openSettings() { $('settingsModal').hidden = false; }
function closeSettings() { $('settingsModal').hidden = true; }

// ======= Init =======
function bindEvents() {
  $('newEmailBtn').addEventListener('click', createAccount);
  $('copyBtn').addEventListener('click', copyEmail);
  $('refreshBtn').addEventListener('click', () => refreshMessages());
  $('changeBtn').addEventListener('click', createAccount);
  $('deleteBtn').addEventListener('click', () => {
    if (!currentAccount) return showToast('لا يوجد بريد');
    deleteAccount(currentAccount.id);
  });
  $('menuBtn').addEventListener('click', openSidebar);
  $('sidebarScrim').addEventListener('click', closeSidebar);
  $('closeModal').addEventListener('click', () => { $('messageModal').hidden = true; openMsgId = null; });
  $('messageModal').addEventListener('click', (e) => { if (e.target === $('messageModal')) $('messageModal').hidden = true; });
  $('deleteMsgBtn').addEventListener('click', () => {
    if (!openMsgId) return;
    if (confirm('حذف هذه الرسالة؟')) { deleteMessage(openMsgId); $('messageModal').hidden = true; openMsgId = null; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('messageModal').hidden = true;
      closeSettings();
      closeSidebar();
    }
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettings(); });
  $('customServer').addEventListener('change', (e) => {
    customServer = e.target.value.trim();
    saveCustomServer();
    renderProvider();
    showToast(customServer ? 'تم حفظ الخادم المخصص' : 'تم مسح الخادم المخصص');
  });
  $('retryBtn').addEventListener('click', () => { hideError(); refreshMessages(); });
  $('downloadBtn').addEventListener('click', () => {
    window.location.href = 'https://github.com/f0uri/baridat/releases/latest';
  });
}

async function init() {
  bindEvents();
  loadAccounts();
  render();
  await new Promise(r => setTimeout(r, 50)); // allow APP_VERSION to resolve
  renderVersion();
  if (currentAccount) {
    await refreshMessages();
    startPolling();
  } else {
    await createAccount();
  }
  registerSW();
  setTimeout(checkUpdate, 1500);
  setInterval(checkUpdate, 60 * 60 * 1000);
  window.addEventListener('focus', checkUpdate);
}

init();
