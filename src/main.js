import './style.css';

// ======= Configuration =======
const API_BASE = 'https://api.mail.tm';
const STORAGE_KEY = 'baridat_accounts_v1';
const CURRENT_KEY = 'baridat_current_v1';
const APP_VERSION = '1.2.0';

// ======= State =======
let accounts = [];
let currentAccount = null;
let messages = [];
let pollTimer = null;
let domains = [];

// ======= DOM =======
const $ = (id) => document.getElementById(id);
const emailList = $('emailList');
const messagesList = $('messagesList');
const currentAddress = $('currentAddress');
const emptyState = $('emptyState');
const loader = $('loader');
const toast = $('toast');
const sidebar = $('sidebar');
const messageModal = $('messageModal');
const updateBanner = $('updateBanner');

// ======= Utilities =======
function showToast(msg, duration = 2200) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

async function api(path, opts = {}, authToken = null) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data['hydra:description'] || `HTTP ${res.status}`);
  return data;
}

function saveAccounts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}
function saveCurrent() {
  if (currentAccount) localStorage.setItem(CURRENT_KEY, currentAccount.id);
  else localStorage.removeItem(CURRENT_KEY);
}

function loadAccounts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    accounts = raw ? JSON.parse(raw) : [];
  } catch { accounts = []; }
  const curId = localStorage.getItem(CURRENT_KEY);
  if (curId) currentAccount = accounts.find(a => a.id === curId) || null;
  if (!currentAccount && accounts.length) currentAccount = accounts[0];
}

// ======= Domains & Accounts =======
async function fetchDomains() {
  if (domains.length) return domains;
  const data = await api('/domains?page=1');
  domains = data['hydra:member'] || [];
  return domains;
}

function randomString(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createAccount() {
  loader.classList.add('show');
  try {
    await fetchDomains();
    const domain = domains.find(d => d.isActive) || domains[0];
    if (!domain) throw new Error('لا يوجد دومين متاح حالياً');
    const address = `${randomString(12)}@${domain.domain}`;
    const password = randomString(20);
    const acc = await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({ address, password }),
    });
    // get token
    const tokenData = await api('/token', {
      method: 'POST',
      body: JSON.stringify({ address, password }),
    });
    const newAcc = {
      id: acc.id,
      address: acc.address,
      password,
      token: tokenData.token,
      createdAt: Date.now(),
      messageCount: 0,
    };
    accounts.unshift(newAcc);
    currentAccount = newAcc;
    saveAccounts();
    saveCurrent();
    renderEmailList();
    renderCurrent();
    await refreshMessages();
    startPolling();
    showToast('تم إنشاء بريد جديد بنجاح ✓');
  } catch (e) {
    showToast('خطأ: ' + e.message);
  } finally {
    loader.classList.remove('show');
  }
}

function switchAccount(accId) {
  currentAccount = accounts.find(a => a.id === accId);
  saveCurrent();
  renderEmailList();
  renderCurrent();
  refreshMessages();
  closeSidebar();
}

function deleteAccount(accId) {
  if (!confirm('هل تريد حذف هذا البريد نهائياً؟')) return;
  accounts = accounts.filter(a => a.id !== accId);
  if (currentAccount?.id === accId) currentAccount = accounts[0] || null;
  saveAccounts();
  saveCurrent();
  renderEmailList();
  renderCurrent();
  if (currentAccount) refreshMessages();
  else {
    messages = [];
    renderMessages();
  }
  showToast('تم حذف البريد');
}

async function changeEmail() {
  // same as new email but replaces current focus
  await createAccount();
}

// ======= Messages =======
async function fetchMessages() {
  if (!currentAccount) return [];
  try {
    const data = await api('/messages?page=1', {}, currentAccount.token);
    return data['hydra:member'] || [];
  } catch (e) {
    // token may be invalid - remove account
    console.warn('fetch messages error', e);
    return [];
  }
}

async function fetchMessage(id) {
  if (!currentAccount) return null;
  return api(`/messages/${id}`, {}, currentAccount.token);
}

async function refreshMessages() {
  if (!currentAccount) {
    messages = [];
    renderMessages();
    return;
  }
  loader.classList.add('show');
  messages = await fetchMessages();
  currentAccount.messageCount = messages.length;
  saveAccounts();
  renderEmailList();
  renderMessages();
  loader.classList.remove('show');
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentAccount) return;
    const prevLen = messages.length;
    const fresh = await fetchMessages();
    if (fresh.length > prevLen) {
      messages = fresh;
      currentAccount.messageCount = messages.length;
      saveAccounts();
      renderMessages();
      renderEmailList();
      showToast('📬 وصلت رسالة جديدة!');
    }
  }, 15000);
}

// ======= Rendering =======
function renderEmailList() {
  emailList.innerHTML = '';
  if (!accounts.length) {
    emailList.innerHTML = '<div style="text-align:center;color:var(--text-dimmer);font-size:13px;padding:20px;">لا توجد صناديق بريد بعد<br/>اضغط "بريد جديد" للبدء</div>';
    return;
  }
  accounts.forEach(acc => {
    const el = document.createElement('div');
    el.className = 'email-item' + (currentAccount?.id === acc.id ? ' active' : '');
    const date = new Date(acc.createdAt);
    const dateStr = date.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit' });
    el.innerHTML = `
      <div class="addr" dir="ltr">${acc.address}</div>
      <div class="meta">
        <span>${dateStr}</span>
        ${acc.messageCount ? `<span class="count-badge">${acc.messageCount}</span>` : ''}
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del-x')) return;
      switchAccount(acc.id);
    });
    // long press / context delete (via double click)
    el.addEventListener('dblclick', () => deleteAccount(acc.id));
    emailList.appendChild(el);
  });
}

function renderCurrent() {
  if (currentAccount) {
    currentAddress.textContent = currentAccount.address;
  } else {
    currentAddress.textContent = '— اضغط "بريد جديد"';
  }
}

function renderMessages() {
  messagesList.innerHTML = '';
  if (!currentAccount || !messages.length) {
    emptyState.classList.remove('hidden');
    messagesList.style.display = 'none';
    return;
  }
  emptyState.classList.add('hidden');
  messagesList.style.display = 'flex';

  messages.forEach(m => {
    const el = document.createElement('div');
    el.className = 'message-item' + (!m.seen ? ' unread' : '');
    const fromName = m.from?.name || m.from?.address?.split('@')[0] || 'مجهول';
    const initial = fromName.charAt(0).toUpperCase();
    const time = m.createdAt ? new Date(m.createdAt).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
    el.innerHTML = `
      <div class="message-avatar">${initial}</div>
      <div class="message-content">
        <div class="message-from-line">
          <span class="message-from" dir="auto">${escapeHtml(fromName)} <span style="color:var(--text-dimmer);font-weight:400;font-size:12px;">&lt;${escapeHtml(m.from?.address || '')}&gt;</span></span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-subject">${escapeHtml(m.subject || '(بدون موضوع)')}</div>
        <div class="message-preview">${escapeHtml(m.intro || '—')}</div>
      </div>
      ${!m.seen ? '<div class="unread-dot"></div>' : ''}
    `;
    el.addEventListener('click', () => openMessage(m.id, el));
    messagesList.appendChild(el);
  });
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function openMessage(id, listEl) {
  try {
    const full = await fetchMessage(id);
    if (!full) return;
    if (!full.seen) {
      listEl.classList.remove('unread');
      const dot = listEl.querySelector('.unread-dot');
      if (dot) dot.remove();
    }
    $('modalSubject').textContent = full.subject || '(بدون موضوع)';
    $('modalFrom').textContent = `${full.from?.name || ''} <${full.from?.address || ''}>`;
    $('modalTo').textContent = (full.to || []).map(t => t.address).join(', ');
    $('modalDate').textContent = full.createdAt ? new Date(full.createdAt).toLocaleString('ar-EG') : '';

    // attachments
    const attBox = $('modalAttachments');
    attBox.innerHTML = '';
    (full.attachments || []).forEach(a => {
      const url = `${API_BASE}/messages/${id}/attachment/${a.filename}?token=${currentAccount.token}`;
      const ael = document.createElement('a');
      ael.className = 'attachment';
      ael.href = url;
      ael.target = '_blank';
      ael.download = a.filename;
      ael.innerHTML = `📎 ${escapeHtml(a.filename)} <span style="opacity:.6">(${formatSize(a.size)})</span>`;
      attBox.appendChild(ael);
    });

    // body
    const iframe = $('modalIframe');
    const html = full.html || (full.text ? `<pre style="font-family:inherit;padding:20px;white-space:pre-wrap;color:#222;">${escapeHtml(full.text)}</pre>` : '<p style="padding:20px;color:#666;">لا محتوى</p>');
    iframe.srcdoc = html;

    messageModal.hidden = false;
  } catch (e) {
    showToast('تعذر فتح الرسالة: ' + e.message);
  }
}

function formatSize(bytes) {
  if (!bytes) return '0B';
  const units = ['B','KB','MB','GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)}${units[i]}`;
}

// ======= Sidebar (mobile) =======
function openSidebar() { sidebar.classList.add('open'); }
function closeSidebar() { sidebar.classList.remove('open'); }

// ======= Copy =======
async function copyCurrentEmail() {
  if (!currentAccount) { showToast('لا يوجد بريد حالياً'); return; }
  try {
    await navigator.clipboard.writeText(currentAccount.address);
    showToast('تم نسخ البريد ✓');
    const btn = $('copyBtn');
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1200);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = currentAccount.address;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('تم نسخ البريد ✓'); } catch {}
    document.body.removeChild(ta);
  }
}

// ======= OTA / Service Worker =======
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    $('versionBadge').textContent = 'v' + APP_VERSION;

    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          updateBanner.hidden = false;
        }
      });
    });

    // check update every 30 min
    setInterval(() => reg.update(), 30 * 60 * 1000);
    // and on focus
    window.addEventListener('focus', () => reg.update());

    $('updateBtn').addEventListener('click', () => {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        reg.waiting.addEventListener('statechange', () => window.location.reload());
      } else {
        window.location.reload();
      }
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  } catch (e) {
    console.warn('SW registration failed', e);
  }
}

// ======= Init =======
function bindEvents() {
  $('newEmailBtn').addEventListener('click', createAccount);
  $('copyBtn').addEventListener('click', copyCurrentEmail);
  $('refreshBtn').addEventListener('click', () => { refreshMessages(); showToast('جاري التحديث...'); });
  $('changeBtn').addEventListener('click', changeEmail);
  $('deleteBtn').addEventListener('click', () => {
    if (!currentAccount) return showToast('لا يوجد بريد لحذفه');
    deleteAccount(currentAccount.id);
  });
  $('menuBtn').addEventListener('click', openSidebar);
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !e.target.closest('#menuBtn')) {
      closeSidebar();
    }
  });
  $('closeModal').addEventListener('click', () => { messageModal.hidden = true; });
  messageModal.addEventListener('click', (e) => { if (e.target === messageModal) messageModal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { messageModal.hidden = true; closeSidebar(); }
  });
  $('settingsBtn').addEventListener('click', () => {
    alert(`بريدات\nالإصدار: ${APP_VERSION}\n\n- البريدات محفوظة محلياً في جهازك\n- التحديثات تصل تلقائياً (OTA)\n- الخدمة: mail.tm\n- انقر نقراً مزدوجاً على بريد في القائمة لحذفه`);
  });
}

async function init() {
  bindEvents();
  loadAccounts();
  renderEmailList();
  renderCurrent();
  if (currentAccount) {
    await refreshMessages();
    startPolling();
  } else {
    // auto-create first account
    await createAccount();
  }
  registerSW();
}

init();
