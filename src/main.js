import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import './style.css';
import { GuerrillaMail, DOMAINS } from './guerrilla.js';
import { extractOtp, parseMessage } from './message.js';

const N = window.BaridatNative || null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE = 'baridat_guerrilla_v1';
let session = null, messages = [], busy = false, polling = false, status = 'جاري الاتصال…', connected = false;
let lastCheck = null, sheetRevision = 0, domainError = '';

function load() {
  try {
    const raw = (N && N.loadString(STORAGE, '')) || localStorage.getItem(STORAGE);
    const data = JSON.parse(raw || 'null');
    if (data && typeof data.email_addr === 'string' && typeof data.sid_token === 'string' && data.email_addr && data.sid_token) {
      session = {email_addr:data.email_addr, sid_token:data.sid_token, seen_ids:Array.isArray(data.seen_ids) ? data.seen_ids.map(String) : [], known_ids:Array.isArray(data.known_ids) ? data.known_ids.map(String) : []};
    }
  } catch {}
}
function save() {
  if (!session) return;
  const data = JSON.stringify(session);
  try { localStorage.setItem(STORAGE, data); } catch {}
  try { N?.storeString(STORAGE, data); } catch {}
}
function request(url) {
  if (!N?.http) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    return fetch(url, {method:'GET', cache:'no-store', credentials:'omit', signal:controller.signal, headers:{Accept:'application/json'}})
      .then(async response => ({ok:response.ok,status:response.status,body:await response.text()}))
      .catch(() => ({ok:false,status:0}))
      .finally(() => clearTimeout(timeout));
  }
  return new Promise(resolve => {
    const cb = '_ncb_' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {delete window[cb]; resolve({ok:false,status:0});}, 45000);
    window[cb] = result => {clearTimeout(timer); delete window[cb]; try {resolve(JSON.parse(result));} catch {resolve({ok:false,status:0});}};
    try { N.http('GET', url, null, null, cb); }
    catch { clearTimeout(timer); delete window[cb]; resolve({ok:false,status:0}); }
  });
}
const api = new GuerrillaMail(request, value => {session = value; save();});
function toast(text) {
  $('#tt').textContent = text; const el = $('#toast'); el.classList.add('show-toast');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show-toast'), 2600);
}
async function copy(value) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea'); input.value = value; document.body.append(input); input.select();
      const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error();
    }
    toast('تم النسخ');
  } catch { toast('تعذر النسخ'); }
}
function openExternal(url) {
  try { if (N?.openUrl) return N.openUrl(url); } catch {}
  window.open(url, '_blank', 'noopener,noreferrer');
}
function formatTime(raw) {
  if (!raw) return '';
  const value = /^\d+$/.test(String(raw)) ? Number(raw) * 1000 : raw;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar', {hour:'2-digit',minute:'2-digit',month:'short',day:'numeric'}).format(date);
}
function domainOptions(current) {
  const extra = current && !DOMAINS.includes(current) ? `<option value="${esc(current)}" selected disabled>${esc(current)}</option>` : '';
  return extra + DOMAINS.map(domain => `<option value="${esc(domain)}"${domain === current ? ' selected' : ''}>${esc(domain)}</option>`).join('');
}
function render() {
  const address = session?.email_addr || 'جاري إنشاء العنوان…';
  $('#address').textContent = address;
  $('#domainError').textContent = domainError; $('#domainError').hidden = !domainError;
  const domain = session?.email_addr.split('@')[1]?.toLowerCase() || '';
  $('#domainSelect').innerHTML = domainOptions(domain);
  $('#domainSelect').disabled = !session || busy;
  $('#statusText').textContent = status;
  $('#statusDot').classList.toggle('online', connected);
  $('#copyAddress').disabled = !session;
  $('#custom').disabled = !session || busy;
  $('#random').disabled = busy;
  $('#refresh').disabled = !session || busy;
  $('#counter').textContent = messages.length;
  const seen = new Set(session?.seen_ids || []);
  $('#list').innerHTML = messages.length ? messages.map(m => `<button class="row glass message-row" data-id="${esc(m.mail_id)}"><span class="av">${esc(String(m.mail_from || '?').charAt(0).toUpperCase())}</span><span class="rb"><span class="r1"><b dir="auto">${esc(m.mail_from || 'مرسل غير معروف')}</b><time>${esc(formatTime(m.mail_timestamp || m.mail_date))}</time></span><span class="r2" dir="auto">${esc(m.mail_subject || '(بدون موضوع)')}</span><span class="r3" dir="auto">${esc(m.mail_excerpt || '')}</span></span>${seen.has(String(m.mail_id)) ? '' : '<i class="ud"></i>'}</button>`).join('') : `<div class="em"><div class="empty-visual"><i></i><i></i><div class="empty-icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="4"/><path d="m4 7 8 6 8-6"/></svg></div><span class="spark s1">✦</span><span class="spark s2">✦</span></div><b>لا توجد رسائل بعد</b><p>عندما تصلك رسالة، ستجدها هنا مباشرةً.</p><span class="empty-hint">يتم التحديث تلقائياً</span></div>`;
}
function setError(error) { connected = false; status = error?.message || 'تعذر الاتصال بخدمة البريد'; render(); }
function showSheet(content) { sheetRevision++; $('#sc').innerHTML = content; $('#scrim').classList.add('on'); $('#sheet').classList.add('open'); }
function closeSheet() { sheetRevision++; $('#scrim').classList.remove('on'); $('#sheet').classList.remove('open'); }
async function create() {
  if (busy) return;
  busy = true; status = 'جاري إنشاء عنوان…'; connected = false; render();
  try {
    await api.create(); domainError = ''; messages = []; lastCheck = null; closeSheet(); toast('تم إنشاء عنوان جديد');
  } catch (error) { setError(error); toast(error.message); }
  finally { busy = false; render(); }
  if (session) poll();
}
function customSheet() {
  const [user, domain] = session.email_addr.split('@');
  showSheet(`<div class="sheet-title"><h2>تخصيص العنوان</h2><button class="ib" data-close aria-label="إغلاق">×</button></div><p>اكتب اسم البريد الجديد. قد يكون الاسم مستخدمًا من شخص آخر.</p><form id="customForm"><label for="customName">اسم البريد والنطاق</label><div class="address-fields" dir="ltr"><input id="customName" dir="ltr" maxlength="30" autocomplete="off" value="${esc(user)}" placeholder="your.name"><span>@</span><select id="customDomain" dir="ltr" aria-label="نطاق البريد">${domainOptions(domain?.toLowerCase())}</select></div><p class="hint">حروف إنجليزية وأرقام والنقاط والشرطة والشرطة السفلية.</p><button class="pill pr" type="submit">حفظ العنوان</button><p id="formError" role="alert"></p></form>`);
  $('#customName').focus();
  $('#customForm').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const name = $('#customName').value.trim(), site = $('#customDomain').value;
    const previousName = session.email_addr.split('@')[0].toLowerCase();
    busy = true; const submit = event.currentTarget.querySelector('button'); submit.disabled = true; render();
    try {
      await api.rename(name, site); domainError = '';
      if (session.email_addr.split('@')[0].toLowerCase() !== previousName) messages = [];
      lastCheck = null; closeSheet(); toast('تم تغيير العنوان');
    } catch (error) { const el = $('#formError'); if (el) el.textContent = error.message; }
    finally { if (session.email_addr.split('@')[0].toLowerCase() !== previousName) messages = []; busy = false; render(); if (submit.isConnected) submit.disabled = false; }
    if (!$('#sheet').classList.contains('open')) poll();
  };
}
async function changeDomain(site) {
  if (!session || busy) return;
  const name = session.email_addr.split('@')[0];
  busy = true; render();
  try {
    await api.rename(name, site); domainError = '';
    lastCheck = null;
    toast('تم تغيير النطاق');
  } catch (error) { domainError = error.message; toast('تعذر تغيير النطاق'); }
  finally { if (session.email_addr.split('@')[0].toLowerCase() !== name.toLowerCase()) messages = []; busy = false; render(); }
  poll();
}
async function poll(manual = false) {
  if (!session || busy || polling) return;
  polling = true;
  const target = session;
  try {
    const list = await api.list();
    if (session !== target || busy) return;
    const known = new Set(session.known_ids || []);
    const fresh = list.filter(m => !known.has(String(m.mail_id)));
    session.known_ids = [...new Set([...known, ...list.map(m => String(m.mail_id))])].slice(-5000);
    messages = list; save(); connected = true; lastCheck = Date.now(); status = 'متصل · فحص تلقائي كل ٦ ثوانٍ'; render();
    if (fresh.length) toast(`وصلت ${fresh.length === 1 ? 'رسالة جديدة' : fresh.length + ' رسائل جديدة'}`);
    else if (manual) toast('تم تحديث الوارد');
  } catch (error) { if (session === target) {setError(error); if (manual) toast(error.message);} }
  finally { polling = false; }
}
async function openMessage(id) {
  const item = messages.find(m => String(m.mail_id) === id); if (!item || busy) return;
  const target = session;
  showSheet('<div class="em"><b>جاري تحميل الرسالة…</b></div>');
  const revision = sheetRevision;
  try {
    const full = await api.read(id);
    if (target !== session || revision !== sheetRevision) return;
    session.seen_ids = [...new Set([...session.seen_ids, id])]; save(); render();
    const body = full.mail_body || full.mail_text || full.mail_excerpt || item.mail_excerpt || '';
    const {text, links} = parseMessage(body);
    const code = extractOtp(full.mail_subject || item.mail_subject, text);
    showSheet(`<div class="sheet-title"><h2 dir="auto">${esc(full.mail_subject || item.mail_subject || '(بدون موضوع)')}</h2><button class="ib" data-close aria-label="إغلاق">×</button></div><p class="sender" dir="auto">${esc(full.mail_from || item.mail_from || '')}</p><time>${esc(formatTime(full.mail_timestamp || item.mail_timestamp || item.mail_date))}</time>${code ? `<div class="otp"><small>رمز التحقق</small><div class="code">${esc(code)}</div><button class="pill pr" data-copy-code="${esc(code)}">نسخ الرمز</button></div>` : ''}<div class="message-body" dir="auto">${esc(text || 'المحتوى غير متاح حالياً. حاول فتح الرسالة مرة أخرى.')}</div>${links.length ? `<div class="sh">روابط التفعيل</div><p class="hint">تحقق من الرابط قبل فتحه؛ قد يقود إلى موقع خارجي.</p><div class="links">${links.map((link, i) => `<button class="pill link-button" data-link-index="${i}" dir="ltr">${esc(link)}</button>`).join('')}</div>` : ''}`);
    $('#sc').querySelectorAll('[data-link-index]').forEach(button => button.onclick = () => openExternal(links[Number(button.dataset.linkIndex)]));
  } catch (error) { if (revision !== sheetRevision || target !== session) return; showSheet(`<div class="sheet-title"><h2>تعذر فتح الرسالة</h2><button class="ib" data-close aria-label="إغلاق">×</button></div><p>${esc(error.message)}</p><button class="pill pr" data-retry="${esc(id)}">إعادة المحاولة</button>`); }
}
// A short synthetic tap: played only after user interaction and can be muted in settings.
let soundEnabled = true, audioContext;
try { soundEnabled = (N?.loadString('click_sound', '1') ?? localStorage.getItem('click_sound') ?? '1') !== '0'; } catch {}
function updateSoundToggle() {
  const toggle = $('#soundToggle'); toggle.classList.toggle('on', soundEnabled); toggle.setAttribute('aria-checked', String(soundEnabled));
}
function clickSound() {
  if (!soundEnabled) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    audioContext ||= new Audio();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const now = audioContext.currentTime, oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(1400, now); oscillator.frequency.exponentialRampToValueAtTime(700, now + .025);
    gain.gain.setValueAtTime(.035, now); gain.gain.exponentialRampToValueAtTime(.0001, now + .035);
    oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + .04);
  } catch {}
}
document.addEventListener('click', event => { const button = event.target.closest('button'); if (button && !button.disabled) clickSound(); }, true);
$('#soundToggle').onclick = () => {
  soundEnabled = !soundEnabled; updateSoundToggle();
  try { localStorage.setItem('click_sound', soundEnabled ? '1' : '0'); N?.storeString('click_sound', soundEnabled ? '1' : '0'); } catch {}
};
updateSoundToggle();
function switchTab(settings) {
  $('#view').hidden = settings; $('#settingsView').hidden = !settings;
  $('#inboxTab').classList.toggle('on', !settings); $('#settingsTab').classList.toggle('on', settings);
  $('#inboxTab').toggleAttribute('aria-current', !settings); $('#settingsTab').toggleAttribute('aria-current', settings);
}
$('#inboxTab').onclick = () => switchTab(false);
$('#settingsTab').onclick = () => switchTab(true);
try { $('#appVersion').textContent = 'بريدات ' + (N?.getAppVersion?.() || '2.7.0'); } catch {}
$('#copyAddress').onclick = () => session && copy(session.email_addr);
$('#random').onclick = create;
$('#custom').onclick = customSheet;
$('#domainSelect').onchange = event => changeDomain(event.target.value);
$('#refresh').onclick = () => poll(true);
$('#list').onclick = event => {const button = event.target.closest('[data-id]'); if (button) openMessage(button.dataset.id);};
$('#scrim').onclick = closeSheet;
$('#sc').onclick = event => {
  if (event.target.closest('[data-close]')) closeSheet();
  const code = event.target.closest('[data-copy-code]'); if (code) copy(code.dataset.copyCode);
  const retry = event.target.closest('[data-retry]'); if (retry) openMessage(retry.dataset.retry);
};
window.addEventListener('online', () => poll());
document.addEventListener('visibilitychange', () => {if (!document.hidden) poll();});
load(); api.restore(session); render();
if (session) poll(); else create();
setInterval(() => {if (!document.hidden && (!lastCheck || Date.now() - lastCheck >= 6000)) poll();}, 6000);

// Native Android downloads a verified GitHub release; the browser cannot install APKs.
let updateUrl = '', updateState = 'idle';
window.onNativeUpdate = raw => {
  let result; try { result = JSON.parse(raw); } catch { return; }
  updateState = result.state;
  $('#updateBanner .ub-txt').textContent = result.message;
  $('#updateBanner').classList.add('show');
  $('#updateBtn').disabled = result.state === 'downloading' || result.state === 'permission' || result.state === 'installing';
  $('#updateBtn').textContent = result.state === 'ready' ? 'تثبيت' : result.state === 'error' ? 'إعادة المحاولة' : result.state === 'downloading' ? 'تنزيل…' : 'تحديث';
};
async function checkUpdate(manual = false) {
  try {
    if (manual) toast('جاري فحص التحديثات…');
    const response = await request('https://raw.githubusercontent.com/f0uri/baridat/main/public/version.json?t=' + Date.now());
    if (!response.ok) throw new Error();
    const info = JSON.parse(response.body);
    const currentCode = N?.getVersionCode ? Number(N.getVersionCode()) : 30;
    if (Number(info.versionCode) > currentCode && typeof info.version === 'string') {
      const url = new URL(info.apkUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.search || url.hash || !/^\/f0uri\/baridat\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/baridat\.apk$/.test(url.pathname)) throw new Error();
      updateUrl = url.href;
      if (!['downloading','permission','ready','installing'].includes(updateState)) {
        updateState = 'available';
        $('#updateBanner .ub-txt').textContent = 'يتوفر إصدار ' + info.version;
        $('#updateBtn').disabled = false; $('#updateBtn').textContent = 'تحديث';
        $('#updateBanner').classList.add('show');
      }
    } else if (manual) toast('أنت تستخدم آخر إصدار');
  } catch { if (manual) toast('تعذر فحص التحديثات'); }
}
$('#updateBtn').onclick = () => {
  if (!N?.downloadUpdate) { toast('تنزيل التحديث داخل التطبيق متاح على أندرويد فقط'); return; }
  if (updateState === 'ready') { N.installUpdate(); return; }
  if (updateUrl) N.downloadUpdate(updateUrl); else { toast('جاري التحقق من الإصدار'); checkUpdate(true); }
};
$('#checkUpdate').onclick = () => checkUpdate(true);
$('#updateClose').onclick = () => $('#updateBanner').classList.remove('show');
try { N?.updateStatus?.(); } catch {}
setTimeout(() => checkUpdate(), 2500);
setInterval(() => checkUpdate(), 6 * 60 * 60 * 1000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
