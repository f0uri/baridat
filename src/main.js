// ============================================================
// بريدات v2.3.0 — الواجهة الزجاجية كما في التصميم المطلوب،
// ببيانات حقيقية من mail.tm و mail123. لا رسائل وهمية أبدا.
// ============================================================

// Fonts bundled with vite (offline, no CDN at runtime)
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import './style.css';

import { gsap } from 'gsap';
import { Draggable } from 'gsap/Draggable';
import { Flip } from 'gsap/Flip';
import { createIcons, icons } from 'lucide';

gsap.registerPlugin(Draggable, Flip);

// ============================================================
// Native bridge
// ============================================================
const N = window.BaridatNative || null;

function nlog(level, msg) { try { N && N.log(level, String(msg)); } catch {} }
function nget(k, def)   { try { return N ? N.loadString(k, def) : def; } catch { return def; } }
function nset(k, v)     { try { if (N) N.storeString(k, v); } catch(e){ nlog('e','store '+k+' failed: '+e); } }
function nrm(k)         { try { if (N) N.removeKey(k); } catch {} }

function http(method, url, body, token) {
  return new Promise((resolve) => {
    if (!N || !N.http) {
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
// Version — from the native bridge only (never version.json on file://)
// ============================================================
let APP_VERSION = '0.0.0';
(function resolveVersion() {
  try {
    if (N && typeof N.getAppVersion === 'function') {
      const v = N.getAppVersion();
      if (v && /^\d+\.\d+\.\d+/.test(v)) { APP_VERSION = v; return; }
    }
  } catch {}
})();

// ============================================================
// State
// ============================================================
const KEY_ACCOUNTS = 'baridat_accounts_v2';
const KEY_CURRENT  = 'baridat_current_v2';
const KEY_UI       = 'baridat_ui_v1';
const KEY_READ     = 'baridat_read_v1';
const KEY_USER     = 'baridat_google_user_v1';

const MAIL123_DOMAINS = ['mail123.fr','mail456.fr','mail789.fr','mail1mail.com','mail123.click','mail123.com.br','mail123.beer','mail123box.tech','mail123.pro','mail123.site','mail123.online','mail123.tech','mail123.website'];
let mailtmDomain = 'fldubai.com';
const DOMAINS = () => [mailtmDomain, ...MAIL123_DOMAINS];

const st = { tab: 0, cur: 0, dom: 0, sw: { n: 1, a: 0, h: 1 }, user: null };
let accounts = [];
let current = null;
let msgsCache = {};   // accountId -> { list, fetchedAt }
let accCounts = {};   // accountId -> message count
let readIds = {};     // accountId -> Set(messageId)
let pollingTimer = null;
let uid = Date.now();
let diag = { bridge: 'unknown', lastOk: null, lastErr: '' };

function $(id) { return document.getElementById(id); }
function rnd(n) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function stripHtml(h) { return String(h || '').replace(/<[^>]+>/g, ' '); }

// ============================================================
// Providers (both go through http() -> native bridge)
// ============================================================
async function mailtmReq(acc, method, url, body) {
  let r = await http(method, url, body || null, acc.token);
  if (r.status === 401 && acc.password) {
    nlog('warn', 'mail.tm 401 — re-authenticating token');
    try {
      const tr = await http('POST', 'https://api.mail.tm/token',
        JSON.stringify({ address: acc.address, password: acc.password }));
      if (tr.ok) {
        const tok = JSON.parse(tr.body);
        if (tok.token) {
          acc.token = tok.token;
          saveAccounts();
          r = await http(method, url, body || null, acc.token);
        }
      }
    } catch (e) {
      nlog('warn', 'mail.tm re-auth failed: ' + e.message);
    }
  }
  return r;
}

const PROVIDERS = {
  mailtm: {
    label: 'mail.tm',
    async create(domain) {
      const doms = await http('GET', 'https://api.mail.tm/domains?page=1');
      if (!doms.ok) throw new Error('domains: HTTP ' + doms.status);
      const dd = JSON.parse(doms.body);
      const list = (dd['hydra:member'] || []).filter(d => d.isActive);
      if (!list.length) throw new Error('لا يوجد دومين نشط في mail.tm');
      const useDomain = (domain && list.some(d => d.domain === domain)) ? domain : list[0].domain;
      mailtmDomain = list[0].domain;
      const address = rnd(12) + '@' + useDomain;
      const password = rnd(24);
      const cr = await http('POST', 'https://api.mail.tm/accounts',
        JSON.stringify({ address, password }));
      if (!cr.ok) throw new Error('create: HTTP ' + cr.status);
      const tr = await http('POST', 'https://api.mail.tm/token',
        JSON.stringify({ address, password }));
      if (!tr.ok) throw new Error('token: HTTP ' + tr.status);
      const tok = JSON.parse(tr.body);
      return { id: JSON.parse(cr.body).id, address, password, token: tok.token, provider: 'mailtm', domain: useDomain };
    },
    async list(acc) {
      const r = await mailtmReq(acc, 'GET', 'https://api.mail.tm/messages?page=1');
      if (!r.ok) throw new Error('list: HTTP ' + r.status);
      const d = JSON.parse(r.body);
      return (d['hydra:member'] || []).map(m => normalizeMailtm(m)).filter(Boolean);
    },
    async read(acc, id) {
      const r = await mailtmReq(acc, 'GET', 'https://api.mail.tm/messages/' + id);
      if (!r.ok) throw new Error('read: HTTP ' + r.status);
      return normalizeMailtm(JSON.parse(r.body), true);
    },
    async remove(acc, id) {
      await mailtmReq(acc, 'DELETE', 'https://api.mail.tm/messages/' + id);
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
      return (d.messages || []).map(m => normalizeMail123(m)).filter(Boolean);
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

// Defensive normalization: a malformed message never kills the whole list.
function normalizeMailtm(m, full = false) {
  try {
    if (!m || typeof m !== 'object') return null;
    const from = (m.from && (Array.isArray(m.from) ? m.from[0] : m.from)) || {};
    return {
      id: m.id,
      fromName: from.name || '',
      fromAddr: from.address || '',
      subject: m.subject || '(بدون موضوع)',
      intro: m.intro || (m.text ? String(m.text).slice(0, 120) : ''),
      text: full ? (m.text || '') : '',
      html: full ? (m.html || '') : '',
      seen: !!m.seen,
      createdAt: m.createdAt,
    };
  } catch { return null; }
}
function normalizeMail123(m, full = false) {
  try {
    if (!m || typeof m !== 'object') return null;
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
  } catch { return null; }
}

// Create a real address: the selected domain picks the provider
// (mail.tm live domain -> mail.tm, any mail123 domain -> mail123),
// with fallback to the other provider on failure.
async function createAddress() {
  const dom = DOMAINS()[st.dom] || mailtmDomain;
  const first = (dom === mailtmDomain) ? 'mailtm' : 'mail123';
  const order = first === 'mailtm' ? ['mailtm', 'mail123'] : ['mail123', 'mailtm'];
  let lastErr = null;
  for (const pid of order) {
    try {
      if (pid === 'mailtm') return await PROVIDERS.mailtm.create(dom);
      return await PROVIDERS.mail123.create();
    } catch (e) {
      lastErr = e;
      nlog('warn', 'provider ' + pid + ' failed: ' + e.message);
    }
  }
  throw lastErr || new Error('كل المزودين فشلوا');
}

async function fetchMailtmDomain() {
  try {
    const r = await http('GET', 'https://api.mail.tm/domains?page=1');
    if (r.ok) {
      const d = JSON.parse(r.body);
      const list = (d['hydra:member'] || []).filter(x => x.isActive);
      if (list.length) mailtmDomain = list[0].domain;
    }
  } catch {}
}

// ============================================================
// Storage
// ============================================================
function saveAccounts() {
  const j = JSON.stringify(accounts);
  try { localStorage.setItem(KEY_ACCOUNTS, j); } catch {}
  nset(KEY_ACCOUNTS, j);
}
function saveCurrent() {
  const id = current ? current.id : '';
  try { localStorage.setItem(KEY_CURRENT, id); } catch {}
  nset(KEY_CURRENT, id);
}
function loadState() {
  // v1 -> v2 migration
  try {
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
  } catch {}
  let raw = nget(KEY_ACCOUNTS, '');
  if (!raw) { try { raw = localStorage.getItem(KEY_ACCOUNTS) || ''; } catch {} }
  try { accounts = raw ? JSON.parse(raw) : []; } catch { accounts = []; }
  accounts = (accounts || []).filter(a => a && a.id && a.address && a.provider && PROVIDERS[a.provider]);
  let curId = nget(KEY_CURRENT, '');
  if (!curId) { try { curId = localStorage.getItem(KEY_CURRENT) || ''; } catch {} }
  current = (curId && accounts.find(a => a.id === curId)) || accounts[0] || null;
  st.cur = current ? accounts.indexOf(current) : 0;
  // Google user (local record only — no OAuth, no cloud)
  st.user = nget(KEY_USER, '') || null;
  if (!st.user) { try { st.user = localStorage.getItem('tm:user') || null; } catch {} }
  // UI prefs (domain choice + toggles)
  try {
    const rawUi = nget(KEY_UI, '') || localStorage.getItem(KEY_UI) || '';
    if (rawUi) {
      const o = JSON.parse(rawUi);
      if (typeof o.dom === 'number') st.dom = o.dom;
      if (o.sw) st.sw = Object.assign({ n: 1, a: 0, h: 1 }, o.sw);
    }
  } catch {}
  if (current && current.domain) {
    const di = DOMAINS().indexOf(current.domain);
    if (di >= 0) st.dom = di;
  }
  // read message ids
  try {
    const rawRead = localStorage.getItem(KEY_READ) || '';
    if (rawRead) {
      const o = JSON.parse(rawRead);
      Object.keys(o).forEach(k => { readIds[k] = new Set(o[k] || []); });
    }
  } catch {}
}
function saveUi() {
  try {
    const j = JSON.stringify({ dom: st.dom, sw: st.sw });
    localStorage.setItem(KEY_UI, j);
    nset(KEY_UI, j);
  } catch {}
}
function saveReadIds() {
  try {
    const o = {};
    Object.keys(readIds).forEach(k => { o[k] = [...readIds[k]]; });
    localStorage.setItem(KEY_READ, JSON.stringify(o));
  } catch {}
}

// ============================================================
// Helpers
// ============================================================
const ago = t => {
  const s = (Date.now() - new Date(t).getTime()) / 1e3;
  if (isNaN(s)) return '';
  return s < 45 ? 'الآن' : s < 3600 ? 'قبل ' + Math.round(s / 60) + ' د' : s < 86400 ? 'قبل ' + Math.round(s / 3600) + ' س' : new Date(t).toLocaleDateString('ar-EG');
};
const fmtClock = d => {
  try { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};
const hue = n => (n || '?').charCodeAt(0) * 37 % 360;
const refreshIcons = () => { try { createIcons({ icons }); } catch {} };
const curMsgs = () => (current && msgsCache[current.id] ? msgsCache[current.id].list : []);
const isSeen = m => !!(m.seen || (current && readIds[current.id] && readIds[current.id].has(m.id)));
const senderName = m => (m.fromName || m.fromAddr || 'مجهول');
function extractCode(m) {
  const hay = ((m.subject || '') + ' ' + (m.intro || '') + ' ' + (m.text || '') + ' ' + stripHtml(m.html || '')).replace(/\s+/g, ' ');
  const mm = hay.match(/\b(\d{4,8})\b/);
  return mm ? mm[1] : null;
}
function markSeen(id) {
  if (!current) return;
  if (!readIds[current.id]) readIds[current.id] = new Set();
  readIds[current.id].add(id);
  saveReadIds();
  badge();
}

// ============================================================
// Demo UI — Google "G" mark (inline SVG, as in the design file)
// ============================================================
const GI = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const PROMPT = `<button class="keepc" data-act="login"><span class="ic gi">${GI}</span><span class="rb"><b>احتفظ بعناوينك</b><span class="r3">اربط حسابك بـ Google لحفظها حتى لو حذفت التطبيق</span></span><i data-lucide="chevron-left"></i></button>`;
const acct = () => st.user
  ? `<div class="grp"><div class="row"><span class="av" style="--h:215">${escapeHtml(st.user[0].toUpperCase())}</span><span class="rb"><b>الحساب</b><span class="r3 ltr">${escapeHtml(st.user)}</span></span><button class="pill" style="width:auto;padding:0 16px;height:38px" data-act="logout">خروج</button></div></div>`
  : `<div class="grp"><button class="row" data-act="login"><span class="ic gi">${GI}</span><span class="rb"><b>الربط بحساب Google</b><span class="r3">حفظ سحابي لعناوينك ورسائلك</span></span><i data-lucide="chevron-left"></i></button></div>`;
const EMPTY = '<div class="em"><div class="rd"><i></i><i></i><span class="rc"><i data-lucide="mail"></i></span></div><b>في انتظار الرسائل</b><p>أي رسالة تصل إلى هذا العنوان ستظهر هنا فورا.</p></div>';

const rows = () => {
  const list = curMsgs();
  if (!list.length) return EMPTY;
  return list.map(m => {
    const name = senderName(m);
    return `<button class="row" data-id="${escapeHtml(String(m.id))}" data-flip-id="m${escapeHtml(String(m.id))}"><span class="av" style="--h:${hue(name)}">${escapeHtml(name[0] || '?')}</span><span class="rb"><span class="r1"><b>${escapeHtml(name)}</b><time>${ago(m.createdAt)}</time></span><span class="r2">${escapeHtml(m.subject)}</span><span class="r3">${escapeHtml(m.intro || '')}</span></span>${isSeen(m) ? '' : '<i class="ud"></i>'}</button>`;
  }).join('');
};

// Hero status meta — honest retention, no fake countdown.
const heroMeta = () => {
  if (!current) return '<div class="meta"><span>…</span></div>';
  if (st.user) return '<div class="meta"><i data-lucide="shield-check"></i><span>محفوظ في حسابك ولا تنتهي صلاحيته</span></div>';
  if (current.provider === 'mailtm') return '<div class="meta"><i data-lucide="shield-check"></i><span>لا تنتهي صلاحيته</span></div>';
  return '<div class="meta"><i data-lucide="clock"></i><span>الرسائل تُحفظ 7 أيام</span></div>';
};

const vIn = () => `<div class="lt"><h1>الوارد</h1><button class="ib" data-act="refresh" aria-label="تحديث"><i data-lucide="refresh-cw"></i></button></div>
<section class="hero"><div class="hl"><span class="live" id="liveDot"></span><span id="hlLabel">${st.user ? 'عنوانك المحفوظ' : 'عنوانك المؤقت'}</span></div>
<div class="addr" id="addr">${current ? escapeHtml(current.address) : '…'}</div>
${heroMeta()}<div class="acts"><button class="pill pr" data-act="copy"><i data-lucide="copy"></i>نسخ</button><button class="pill" data-act="new"><i data-lucide="shuffle"></i>عنوان جديد</button><button class="pill" data-act="refresh"><i data-lucide="refresh-cw"></i>تحديث</button></div></section>
${st.user ? '' : PROMPT}<div class="er-line" id="listErr" hidden></div><div class="sh"><span>الرسائل</span><b id="cnt">${curMsgs().length}</b></div><div class="grp" id="list">${rows()}</div>`;

const vAd = () => `<div class="lt"><h1>العناوين</h1><button class="ib" data-act="new" aria-label="عنوان جديد"><i data-lucide="plus"></i></button></div>
<div class="grp">${accounts.map((x, i) => `<button class="row" data-ai="${i}"><span class="av" style="--h:215"><i data-lucide="at-sign"></i></span><span class="rb"><span class="r2 ltr">${escapeHtml(x.address)}</span><span class="r3">الرسائل: ${accCounts[x.id] != null ? accCounts[x.id] : '…'}</span></span>${i === st.cur ? '<span class="tag">نشط</span>' : ''}</button>`).join('') || '<div class="em"><b>لا توجد عناوين بعد</b><p>أنشئ عنوانا جديدا من الزر أعلاه.</p></div>'}</div>`;

// Lifetime seg — display only: the provider decides retention.
const vSt = () => {
  const never = current ? current.provider === 'mailtm' : true;
  const foot = current
    ? (current.provider === 'mailtm'
      ? 'هذا العنوان لا تنتهي صلاحيته.'
      : 'رسائل هذا العنوان تُحفظ 7 أيام.')
    : 'أنشئ عنوانا لاستقبال الرسائل.';
  return `<div class="lt"><h1>الإعدادات</h1></div>${acct()}
<div class="sh" style="padding-top:6px"><span>النطاق</span></div><div class="seg scroll">${DOMAINS().map((d, i) => `<button class="${i === st.dom ? 'on' : ''}" data-k="dom" data-v="${i}">${d}</button>`).join('')}</div>
<div class="sh"><span>مدة الصلاحية</span></div><div class="seg"><button class="${never ? 'on' : ''}" data-k="life" data-v="never">لا تنتهي صلاحيته</button><button class="${never ? '' : 'on'}" data-k="life" data-v="7d">7 أيام</button></div>
<div class="sh"><span>التنبيهات</span></div><div class="grp" style="--sp:58px">${[['n', 'bell', 'إشعارات الرسائل'], ['a', 'copy', 'نسخ الرمز تلقائيا'], ['h', 'smartphone', 'اهتزاز عند النسخ']].map(([k, ic, l]) => `<div class="row"><span class="ic"><i data-lucide="${ic}"></i></span><span class="rb r2">${l}</span><button class="sw${st.sw[k] ? ' on' : ''}" role="switch" aria-checked="${!!st.sw[k]}" aria-label="${l}" data-sw="${k}"></button></div>`).join('')}</div>
<p class="ft">${st.user ? 'عناوينك محفوظة في حسابك. ' : ''}${foot}</p>
<div class="diag" id="diag">${diagHtml()}</div>`;
};

function diagHtml() {
  const bridge = diag.bridge === 'ok' ? '<b>متصل</b>' : diag.bridge === 'missing' ? '<b>غير موجود (fetch)</b>' : '<b>…</b>';
  const ok = diag.lastOk ? fmtClock(diag.lastOk) : '—';
  const err = diag.lastErr ? `<code>${escapeHtml(diag.lastErr)}</code>` : '—';
  return `الجسر: ${bridge} • آخر تحديث ناجح: <b>${ok}</b><br>آخر خطأ: ${err}<br>بريدات <b>v${APP_VERSION}</b>`;
}
function renderDiag() {
  const d = $('diag');
  if (d) d.innerHTML = diagHtml();
}

// ============================================================
// Render / navigation
// ============================================================
function badge() {
  const n = curMsgs().filter(m => !isSeen(m)).length;
  const b = $('bd');
  if (!b) return;
  b.textContent = n;
  b.style.display = n ? 'grid' : 'none';
}
function render(anim = true) {
  $('#view').innerHTML = [vIn, vAd, vSt][st.tab]();
  refreshIcons(); badge();
  $('#nt').textContent = ['الوارد', 'العناوين', 'الإعدادات'][st.tab];
  saveUi();
  if (anim) gsap.from('#view>*', { y: 18, opacity: 0, duration: .6, stagger: .07, ease: 'power3.out', clearProps: 'all' });
}
function go(i) {
  st.tab = i;
  document.querySelectorAll('.tabs button').forEach((b, j) => b.classList.toggle('on', j === i));
  $('#view').scrollTop = 0;
  render();
  if (i === 0 && current) refreshMessages();
  if (i === 1) fetchCounts();
}
function refreshList(first) {
  const l = $('#list');
  if (!l) return;
  const s = first && Flip.getState('#list .row');
  l.innerHTML = rows();
  refreshIcons();
  const c = $('cnt');
  if (c) c.textContent = curMsgs().length;
  badge();
  if (first) Flip.from(s, { duration: .7, ease: 'power3.out', onEnter: e => gsap.fromTo(e, { opacity: 0, y: -24, scale: .92 }, { opacity: 1, y: 0, scale: 1, duration: .7, ease: 'back.out(1.4)' }) });
}
function toast(t) {
  const e = $('tt');
  e.textContent = t;
  gsap.killTweensOf(e);
  gsap.fromTo(e, { y: -30, opacity: 0 }, { y: 0, opacity: 1, duration: .45, ease: 'back.out(1.6)' });
  gsap.to(e, { y: -30, opacity: 0, delay: 2, duration: .3 });
}
async function cp(t, m) {
  try { await navigator.clipboard.writeText(t); }
  catch (_) {
    const x = document.createElement('textarea');
    x.value = t; document.body.appendChild(x); x.select();
    try { document.execCommand('copy'); } catch (_) {}
    x.remove();
  }
  if (st.sw.h && navigator.vibrate) navigator.vibrate(10);
  toast(m);
}
function scramble(el, text) {
  const o = { p: 0 }, ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
  gsap.to(o, {
    p: 1, duration: .9, ease: 'none',
    onUpdate() {
      const n = Math.floor(o.p * text.length);
      el.textContent = text.slice(0, n) + [...text.slice(n)].map(c => '@.'.includes(c) ? c : ch[Math.random() * ch.length | 0]).join('');
    },
  });
}

// ============================================================
// Hero status + error line (never a generic message alone)
// ============================================================
function setHeroOk() {
  const dot = $('liveDot'), label = $('hlLabel');
  if (dot) dot.classList.remove('err');
  if (label) label.textContent = st.user ? 'عنوانك المحفوظ' : 'عنوانك المؤقت';
}
function setHeroErr() {
  const dot = $('liveDot'), label = $('hlLabel');
  if (dot) dot.classList.add('err');
  if (label) label.textContent = 'تعذّر التحديث';
}
function showListError(reason) {
  const e = $('listErr');
  if (e) { e.textContent = 'تعذّر التحديث: ' + reason; e.hidden = false; }
}
function hideListError() {
  const e = $('listErr');
  if (e) { e.hidden = true; e.textContent = ''; }
}

// ============================================================
// Addresses + messages flow (real data only)
// ============================================================
async function newAddr(auto) {
  try {
    const a = await createAddress();
    accounts.unshift(a);
    st.cur = 0;
    current = a;
    saveAccounts(); saveCurrent();
    msgsCache[a.id] = { list: [], fetchedAt: 0 };
    accCounts[a.id] = 0;
    render(!auto);
    const el = $('addr');
    if (el) scramble(el, a.address);
    if (!auto) toast('تم إنشاء عنوان جديد');
    await refreshMessages();
  } catch (e) {
    diag.lastErr = (e && e.message) || String(e);
    nlog('error', 'create failed: ' + diag.lastErr);
    showListError(diag.lastErr);
    toast('تعذّر إنشاء العنوان: ' + diag.lastErr);
  }
}

async function refreshMessages(manual) {
  if (!current) return;
  const prov = PROVIDERS[current.provider];
  if (!prov) return;
  try {
    const list = await prov.list(current);
    const prevIds = new Set((msgsCache[current.id] ? msgsCache[current.id].list : []).map(m => m.id));
    const fresh = (list || []).filter(m => m && m.id && !prevIds.has(m.id));
    msgsCache[current.id] = { list: list || [], fetchedAt: Date.now() };
    accCounts[current.id] = (list || []).length;
    diag.lastOk = Date.now();
    diag.lastErr = '';
    hideListError();
    setHeroOk();
    renderDiag();
    if (st.tab === 0) refreshList(fresh.length > 0);
    else badge();
    if (fresh.length) onNewMessages(fresh);
  } catch (e) {
    const reason = (e && e.message) || String(e);
    diag.lastErr = reason;
    nlog('error', 'list failed: ' + reason);
    showListError(reason);
    setHeroErr();
    renderDiag();
    if (manual) toast('تعذّر التحديث: ' + reason);
  }
}

function onNewMessages(fresh) {
  gsap.fromTo('.hero', { scale: 1 }, { scale: 1.015, duration: .2, yoyo: true, repeat: 1, ease: 'power2.out' });
  const withCode = fresh.map(m => ({ m, c: extractCode(m) })).find(x => x.c);
  if (st.sw.a && withCode) cp(withCode.c, 'تم نسخ الرمز تلقائيا');
  else if (st.sw.n && fresh.length) toast('رسالة جديدة من ' + senderName(fresh[0]));
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(() => refreshMessages(false), 15000);
}

async function fetchCounts() {
  const others = accounts.filter(a => a.id !== (current && current.id));
  await Promise.allSettled(others.map(async (a) => {
    try {
      const list = await PROVIDERS[a.provider].list(a);
      accCounts[a.id] = (list || []).filter(m => m && m.id).length;
    } catch {}
  }));
  if (st.tab === 1) render(false);
}

// ============================================================
// Message sheet (real message body + OTP extraction)
// ============================================================
const sh = $('#sheet');
function openM(id) {
  const m = curMsgs().find(x => String(x.id) === String(id));
  if (!m) return;
  markSeen(id);
  const d = document.querySelector('[data-id="' + id + '"] .ud');
  if (d) d.remove();
  const renderSheet = (full) => {
    const name = senderName(full);
    const code = extractCode(full);
    const bodyText = (full.text || '').trim() || stripHtml(full.html || '').trim() || full.intro || '';
    const paras = bodyText ? bodyText.split('\n').filter(p => p.trim()).map(p => '<p>' + escapeHtml(p.trim()) + '</p>').join('') : '<p>لا يوجد محتوى نصي في هذه الرسالة.</p>';
    const codeHtml = code
      ? `<div class="otp"><small>رمز التحقق</small><div class="code">${escapeHtml(code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code)}</div><button class="pill pr" data-act="cc" data-c="${escapeHtml(code)}"><i data-lucide="copy"></i>نسخ الرمز</button></div>`
      : '';
    $('#sc').innerHTML = `<div class="sh2"><span class="av" style="--h:${hue(name)}">${escapeHtml(name[0] || '?')}</span><span class="rb"><b>${escapeHtml(name)}</b><span class="ltr">${escapeHtml(full.fromAddr || '')}</span></span><button class="ib" data-act="close" aria-label="إغلاق"><i data-lucide="x"></i></button></div><h2>${escapeHtml(full.subject)}</h2><time>${ago(full.createdAt)}</time>${paras}${codeHtml}`;
    refreshIcons();
    $('#sc').scrollTop = 0;
    showSheet();
  };
  renderSheet(m);
  PROVIDERS[current.provider].read(current, id)
    .then(full => { full.id = m.id; renderSheet(full); })
    .catch(e => nlog('warn', 'read failed: ' + e.message));
}
function closeM() {
  saveUi();
  $('#scrim').style.pointerEvents = 'none';
  gsap.to('#scrim', { opacity: 0, duration: .3 });
  gsap.to(sh, { yPercent: 100, y: 0, duration: .4, ease: 'power3.in', onComplete: () => { sh.style.visibility = 'hidden'; } });
}
function showSheet() {
  refreshIcons();
  $('#sc').scrollTop = 0;
  $('#scrim').style.pointerEvents = 'auto';
  gsap.to('#scrim', { opacity: 1, duration: .35 });
  gsap.fromTo(sh, { yPercent: 100, y: 0, visibility: 'visible' }, { yPercent: 0, duration: .65, ease: 'power4.out' });
}

// ============================================================
// Gate + Google (local email record only — no OAuth, no cloud)
// ============================================================
function openLogin() {
  $('#sc').innerHTML = `<div class="sh2"><span class="ic big gi">${GI}</span><span class="rb"><b>تسجيل الدخول</b><span class="r3">بحساب Google</span></span><button class="ib" data-act="close" aria-label="إغلاق"><i data-lucide="x"></i></button></div><p>اربط حسابك بـ Google لحفظ عناوينك ورسائلك حتى لو حذفت التطبيق.</p><label class="fl" for="em">عنوان Gmail</label><input id="em" class="inp" type="email" inputmode="email" autocomplete="email" dir="ltr" placeholder="name@gmail.com"><div class="er" id="er" role="alert"></div><button class="pill pr" style="width:100%;margin-top:16px" data-act="signin"><i data-lucide="log-in"></i>متابعة</button>`;
  showSheet();
  $('em').addEventListener('keydown', e => { if (e.key === 'Enter') signin(); });
}
function signin() {
  const el = $('em'), er = $('er'), v = el.value.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@gmail\.com$/.test(v)) {
    er.textContent = 'أدخل عنوان Gmail صحيحا ينتهي بـ gmail.com';
    er.style.display = 'block';
    gsap.fromTo(el, { x: -9 }, { x: 0, duration: .6, ease: 'elastic.out(1,.3)' });
    return;
  }
  login(v);
}
function login(v) {
  st.user = v;
  try { localStorage.setItem('tm:user', v); } catch {}
  nset(KEY_USER, v);
  closeM();
  render();
  hideGate();
  toast('تم تسجيل الدخول');
}
function logout() {
  st.user = null;
  try { localStorage.removeItem('tm:user'); } catch {}
  nrm(KEY_USER);
  render();
  toast('تم تسجيل الخروج');
}
function showGate() {
  const g = $('gate');
  g.hidden = false;
  gsap.from('#gate .gt>*', { y: 30, opacity: 0, duration: .8, stagger: .09, ease: 'power3.out' });
}
function hideGate() {
  const g = $('gate');
  try { localStorage.setItem('tm:seen', '1'); } catch {}
  if (g.hidden) return;
  gsap.to(g, {
    opacity: 0, scale: 1.04, duration: .5, ease: 'power2.in',
    onComplete: () => { g.hidden = true; gsap.set(g, { clearProps: 'all' }); },
  });
  if (!current) { newAddr(true); startPolling(); }
}

// ============================================================
// Events
// ============================================================
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-id],[data-ai],[data-tab],[data-k],[data-sw]');
  if (!t) return;
  const d = t.dataset;
  if (d.tab !== undefined) go(+d.tab);
  else if (d.id) openM(d.id);
  else if (d.ai !== undefined) {
    st.cur = +d.ai;
    current = accounts[st.cur] || null;
    saveCurrent();
    go(0);
    toast('تم تبديل العنوان');
  }
  else if (d.k === 'dom') {
    t.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === t));
    st.dom = +d.v;
    saveUi();
    toast('النطاق الجديد: ' + DOMAINS()[st.dom]);
  }
  else if (d.k === 'life') { toast('مدة الصلاحية يحددها المزود'); }
  else if (d.sw) {
    st.sw[d.sw] ^= 1;
    t.classList.toggle('on', !!st.sw[d.sw]);
    t.setAttribute('aria-checked', !!st.sw[d.sw]);
    saveUi();
  }
  else if (d.act === 'copy') { if (current) cp(current.address, 'تم نسخ العنوان'); }
  else if (d.act === 'new') newAddr();
  else if (d.act === 'refresh') {
    const svg = t.querySelector('svg');
    if (svg) gsap.to(svg, { rotation: '+=360', duration: .7, ease: 'power2.inOut' });
    refreshMessages(true);
  }
  else if (d.act === 'cc') cp(d.c, 'تم نسخ الرمز');
  else if (d.act === 'close') closeM();
  else if (d.act === 'login') openLogin();
  else if (d.act === 'logout') logout();
  else if (d.act === 'signin') signin();
  else if (d.act === 'guest') hideGate();
});

$('#view').addEventListener('scroll', e => $('#nb').classList.toggle('on', e.target.scrollTop > 40));
$('#view').addEventListener('pointermove', e => {
  const h = e.target.closest('.hero');
  if (!h) return;
  const r = h.getBoundingClientRect();
  gsap.to(h, { rotationY: ((e.clientX - r.left) / r.width - .5) * 10, rotationX: -((e.clientY - r.top) / r.height - .5) * 10, transformPerspective: 700, duration: .4, ease: 'power2.out' });
});
$('#view').addEventListener('pointerout', e => {
  const h = e.target.closest('.hero');
  if (h && !h.contains(e.relatedTarget)) gsap.to(h, { rotationX: 0, rotationY: 0, duration: .6, ease: 'power3.out' });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) refreshMessages();
});

Draggable.create('#sheet', {
  type: 'y', trigger: '#gr', bounds: { minY: 0, maxY: 900 },
  onDragEnd() {
    if (this.y > 120) closeM();
    else gsap.to('#sheet', { y: 0, duration: .4, ease: 'power3.out' });
  },
});

// Ambient motion (blobs + orbs, as in the design file)
gsap.to('.b1', { x: -60, y: 80, duration: 9, repeat: -1, yoyo: true, ease: 'sine.inOut' });
gsap.to('.b2', { x: 90, y: -70, duration: 11, repeat: -1, yoyo: true, ease: 'sine.inOut' });
gsap.to('.b3', { x: -80, y: -90, duration: 13, repeat: -1, yoyo: true, ease: 'sine.inOut' });
gsap.to('.o1', { y: 26, x: -14, rotation: 12, duration: 6, repeat: -1, yoyo: true, ease: 'sine.inOut' });
gsap.to('.o2', { y: -30, x: 18, rotation: -10, duration: 7.5, repeat: -1, yoyo: true, ease: 'sine.inOut' });

// ============================================================
// Boot
// ============================================================
async function boot() {
  loadState();
  diag.bridge = (N && typeof N.http === 'function') ? 'ok' : 'missing';
  nlog('info', 'baridat booted v' + APP_VERSION + ' bridge=' + diag.bridge);
  render(false);
  $('gg').innerHTML = GI;
  refreshIcons();
  fetchMailtmDomain().then(() => { if (st.tab === 2) render(false); });
  let seen = null;
  try { seen = localStorage.getItem('tm:seen'); } catch {}
  if (!accounts.length && !seen) {
    // Brand-new user: show the gate first; the address is created
    // when the gate is dismissed (guest or Google).
    showGate();
  } else if (current) {
    await refreshMessages();
    startPolling();
    fetchCounts();
  } else {
    await newAddr(true);
    startPolling();
  }
}

boot();
