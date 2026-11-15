import './style.css';

/* =========================================================
   Native bridge + HTTP (all mail traffic goes through Kotlin)
   ========================================================= */
const N = window.BaridatNative || null;
function nlog(l, m){ try{ N && N.log(l, String(m)); }catch{} }
function nget(k, d){ try{ return N?N.loadString(k,d):d; }catch{return d} }
function nset(k, v){ try{ if(N) N.storeString(k,v); }catch(e){ nlog('e','store '+k+': '+e); } }

function http(method, url, body, token){
  return new Promise(resolve => {
    if(!N || !N.http){
      fetch(url,{method,headers:Object.assign({'Accept':'application/json'},body?{'Content-Type':'application/json'}:{},token?{'Authorization':'Bearer '+token}:{}),body:body||undefined})
        .then(r=>r.text().then(t=>resolve({ok:r.ok,status:r.status,body:t})))
        .catch(e=>resolve({ok:false,status:0,error:String(e)}));
      return;
    }
    const cb='_ncb_'+Math.random().toString(36).slice(2);
    window[cb]=function(res){
      try{delete window[cb]}catch{}
      try{resolve(JSON.parse(res))}catch{resolve({ok:false,status:0,error:'bad-json'})}
    };
    try{ N.http(method,url,body||null,token||null,cb); }
    catch(e){ resolve({ok:false,status:0,error:'http-exc: '+e}); }
  });
}
function openUrl(u){
  try{
    if(N && N.openUrl){ N.openUrl(u); return; }
  }catch{}
  window.location.href = u;
}

/* =========================================================
   Version
   ========================================================= */
let APP_VERSION='0.0.0';
(function resolveVersion(){
  try{
    if(N && typeof N.getAppVersion==='function'){
      const v=N.getAppVersion();
      if(v && /^\d+\.\d+\.\d+/.test(v)){ APP_VERSION=v; return; }
    }
  }catch{}
  try{
    const x=new XMLHttpRequest();
    x.open('GET','./version.json',false); x.send(null);
    if(x.status===200||x.status===0){ const d=JSON.parse(x.responseText); if(d&&d.version) APP_VERSION=d.version; }
  }catch{}
})();

/* =========================================================
   Storage
   ========================================================= */
const KA='baridat_addrs_v1', KC='baridat_cur_v1', KS='baridat_set_v1';
let addrs=[]; let curIdx=0; let activeProvider='mailtm';
const settings = {
  dom: parseInt(nget('dom','0'),10)||0,
  life: parseInt(nget('life','600'),10)||600,
  notif: nget('notif','1')==='1',
  autoCopy: nget('autoCopy','0')==='1',
  lastOk: nget('lastOk','mailtm'),
};
function saveAll(){
  const j=JSON.stringify({addrs,curIdx,settings});
  try{ localStorage.setItem(KA,j); }catch{}
  nset(KA,j);
}
function saveSettings(){
  nset('dom',String(settings.dom)); nset('life',String(settings.life));
  nset('notif',settings.notif?'1':'0'); nset('autoCopy',settings.autoCopy?'1':'0');
  nset('lastOk',settings.lastOk); saveAll();
}
function loadAll(){
  let raw=nget(KA,''); if(!raw) raw=localStorage.getItem(KA)||'';
  try{ const d=raw?JSON.parse(raw):null; if(d&&Array.isArray(d.addrs)){ addrs=d.addrs; curIdx=d.curIdx||0; Object.assign(settings,d.settings||{}); } }catch{}
  if(curIdx>=addrs.length) curIdx=0;
}
function current(){ return addrs[curIdx]||null; }

/* =========================================================
   Providers
   ========================================================= */
const DOMAINS = ['tempnest.app','inboxly.cc','vanish.mail'];
const PROVIDERS = {
  mailtm:{
    label:'mail.tm',
    async create(){
      const r=await http('GET','https://api.mail.tm/domains?page=1');
      if(!r.ok) throw new Error('domains '+r.status);
      const d=JSON.parse(r.body);
      const list=(d['hydra:member']||[]).filter(x=>x.isActive);
      if(!list.length) throw new Error('لا يوجد دومين');
      const dom=list[0].domain, addr=rnd(12)+'@'+dom, pw=rnd(24);
      const cr=await http('POST','https://api.mail.tm/accounts',JSON.stringify({address:addr,password:pw}));
      if(!cr.ok) throw new Error('create '+cr.status);
      const tr=await http('POST','https://api.mail.tm/token',JSON.stringify({address:addr,password:pw}));
      if(!tr.ok) throw new Error('token '+tr.status);
      return {id:JSON.parse(cr.body).id,address:addr,password:pw,token:JSON.parse(tr.body).token,provider:'mailtm',createdAt:Date.now(),msgs:[]};
    },
    async list(a){ const r=await http('GET','https://api.mail.tm/messages?page=1',null,a.token);
      if(!r.ok) throw new Error('list '+r.status); const d=JSON.parse(r.body);
      return (d['hydra:member']||[]).map(nMailtm); },
    async read(a,id){ const r=await http('GET','https://api.mail.tm/messages/'+id,null,a.token);
      if(!r.ok) throw new Error('read '+r.status); return nMailtm(JSON.parse(r.body),true); },
    async remove(a,id){ await http('DELETE','https://api.mail.tm/messages/'+id,null,a.token); },
  },
  mail123:{
    label:'mail123',
    async create(){
      const r=await http('GET','https://mail123.fr/api/v1/mailbox/new');
      if(!r.ok) throw new Error('mail123 '+r.status);
      const d=JSON.parse(r.body);
      if(!d.success) throw new Error('mail123 رفض');
      return {id:d.box+'@'+d.domain,address:d.address,password:'',token:'',provider:'mail123',createdAt:Date.now(),box:d.box,domain:d.domain,msgs:[]};
    },
    async list(a){ const r=await http('GET','https://mail123.fr/api/v1/mailbox/'+encodeURIComponent(a.address)+'/messages');
      if(!r.ok){ if(r.status===429) throw new Error('rate-limit'); throw new Error('list '+r.status); }
      const d=JSON.parse(r.body); if(!d.success) throw new Error(d.error||'list fail');
      return (d.messages||[]).map(nMail123); },
    async read(a,id){ const r=await http('GET','https://mail123.fr/api/v1/mailbox/'+encodeURIComponent(a.address)+'/messages/'+encodeURIComponent(id));
      if(!r.ok) throw new Error('read '+r.status); const d=JSON.parse(r.body); return nMail123(d.message||d,true); },
    async remove(a,id){ await http('DELETE','https://mail123.fr/api/v1/mailbox/'+encodeURIComponent(a.address)+'/messages/'+encodeURIComponent(id)); },
  }
};
function nMailtm(m,full){const f=(m.from&&(Array.isArray(m.from)?m.from[0]:m.from))||{};return{id:m.id,fromName:f.name||'',fromAddr:f.address||'',subject:m.subject||'(بدون موضوع)',intro:m.intro||(m.text?m.text.slice(0,100):''),text:full?(m.text||''):'',html:full?(m.html||''):'',seen:!!m.seen,createdAt:m.createdAt};}
function nMail123(m,full){const f=m.from||m.sender||{};return{id:m.id||m.uid||m._id||m.message_id,fromName:f.name||f.address_name||'',fromAddr:f.address||f.mail||m.from_address||'',subject:m.subject||m.title||'(بدون موضوع)',intro:m.preview||m.intro||(m.text||m.body_text||'').slice(0,100),text:full?(m.text||m.body_text||''):'',html:full?(m.html||m.body_html||''):'',seen:!!m.seen||!!m.read,createdAt:m.created_at||m.createdAt||m.date};}
async function tryCreate(){
  const order=[settings.lastOk,'mailtm','mail123'].filter((v,i,a)=>a.indexOf(v)===i);
  let le=null;
  for(const p of order){ try{const a=await PROVIDERS[p].create();settings.lastOk=p;saveSettings();activeProvider=p;return a;}catch(e){le=e;nlog('warn',p+' fail: '+e.message);} }
  throw le||new Error('كل المزودين فشلوا');
}
function rnd(n){const a='abcdefghijklmnopqrstuvwxyz0123456789';let s='';for(let i=0;i<n;i++)s+=a[Math.floor(Math.random()*a.length)];return s;}
const $=s=>document.querySelector(s);

/* =========================================================
   Helpers
   ========================================================= */
let tab=0, pollTimer=null;
function ago(t){const s=(Date.now()-t)/1e3;if(s<45)return'الآن';if(s<3600)return'قبل '+Math.round(s/60)+' د';if(s<86400)return'قبل '+Math.round(s/3600)+' س';return new Date(t).toLocaleDateString('ar-EG');}
function hue(s){return((s&&s.charCodeAt(0))||77)*37%360;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function safeHtml(h){return String(h||'').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/\son\w+\s*=\s*"[^"]*"/gi,'').replace(/\son\w+\s*=\s*'[^']*'/gi,'').replace(/javascript:/gi,'blocked:');}
function otp(t){const m=String(t||'').replace(/\s+/g,' ').match(/\b(\d{4,8})\b/);return m?m[1]:null;}
async function copy(t){try{await navigator.clipboard.writeText(t);}catch{const x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();try{document.execCommand('copy')}catch{}x.remove();}}
function toast(msg){const e=$('#tt');e.textContent=msg;const c=$('#toast');c.style.opacity='1';c.style.transform='translate(-50%,0)';clearTimeout(toast._t);toast._t=setTimeout(()=>{c.style.opacity='0';c.style.transform='translate(-50%,-20px)';},2200);}

/* =========================================================
   Sheet
   ========================================================= */
function openSheet(html){$('#sc').innerHTML=html;$('#sc').scrollTop=0;$('#scrim').classList.add('on');$('#sheet').classList.add('open');bindSheet();}
function closeSheet(){$('#scrim').classList.remove('on');$('#sheet').classList.remove('open');}
function bindSheet(){
  const cl=$('#sc').querySelector('[data-act="close"]'); if(cl) cl.onclick=closeSheet;
  const cc=$('#sc').querySelector('[data-act="cc"]'); if(cc) cc.onclick=()=>{copy(cc.dataset.c);toast('تم نسخ الرمز');};
}

/* =========================================================
   Icons (Lucide inline)
   ========================================================= */
const ICO={
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><polyline points="21 3 21 8 16 8"/><polyline points="3 21 3 16 8 16"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  shuffle:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  at:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 8 6 8-6"/><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  cp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>',
  dload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};
function ib(act,svg,lbl){return`<button class="ib" data-act="${act}" aria-label="${lbl}">${svg}</button>`;}

/* =========================================================
   Views
   ========================================================= */
function vInbox(){
  const c=current();
  if(!c) return `<div class="em"><div class="rd"><i></i><i></i><span class="rc">${ICO.mail}</span></div><b>جاري إنشاء بريد…</b><p>انتظر لحظة.</p></div>`;
  return `<div class="lt"><h1>الوارد</h1>${ib('refresh',ICO.refresh,'تحديث')}</div>
    <section class="hero">
      <div class="hl"><span class="live"></span>${PROVIDERS[c.provider]?.label||'مخصص'}</div>
      <div class="addr">${esc(c.address)}</div>
      <div class="meta"><span style="display:inline-flex;align-items:center;gap:6px">${ICO.at.replace('class="lucide"','')}${DOMAINS[settings.dom]||c.address.split('@')[1]}</span></div>
      <div class="acts">
        <button class="pill pr" data-act="copy">${ICO.copy} نسخ</button>
        <button class="pill" data-act="new">${ICO.shuffle} عنوان جديد</button>
        <button class="pill" data-act="ext">${ICO.ext} تمديد</button>
      </div>
    </section>
    <div class="sh"><span>الرسائل</span><b>${c.msgs.length}</b></div>
    <div class="grp" id="list">${c.msgs.length?rows(c.msgs):empty()}</div>`;
}
function empty(){return`<div class="em"><div class="rd"><i></i><i></i><span class="rc">${ICO.mail}</span></div><b>في انتظار الرسائل</b><p>أي رسالة تصل لهذا العنوان ستظهر هنا فوراً.</p></div>`;}
function rows(list){return list.map(m=>`<button class="row glass" data-id="${m.id}">
  <span class="av" style="--h:${hue(m.fromName||m.fromAddr)}">${esc((m.fromName||m.fromAddr||'?').charAt(0).toUpperCase())}</span>
  <span class="rb"><span class="r1"><b>${esc(m.fromName||m.fromAddr||'مجهول')}</b><time>${ago(m.createdAt)}</time></span>
  <span class="r2">${esc(m.subject)}</span><span class="r3">${esc(m.intro||'')}</span></span>
  ${m.seen?'':'<i class="ud"></i>'}</button>`).join('');}
function vAddrs(){return`<div class="lt"><h1>العناوين</h1>${ib('new',ICO.plus,'عنوان جديد')}</div>
  <div class="grp">${addrs.map((a,i)=>`<button class="row glass" data-ai="${i}">
    <span class="av" style="background:linear-gradient(135deg,#6d28d9,#c026d3,#e11d48)">${ICO.at}</span>
    <span class="rb"><span class="r2 ltr">${esc(a.address)}</span><span class="r3">الرسائل: ${a.msgs.length} · ${PROVIDERS[a.provider]?.label||'—'}</span></span>
    ${i===curIdx?'<span class="tag">نشط</span>':''}</button>`).join('')}</div>`;}
function vSettings(){return`<div class="lt"><h1>الإعدادات</h1></div>
  <div class="sh"><span>النطاق</span></div>
  <div class="seg glass">${DOMAINS.map((d,i)=>`<button class="${i===settings.dom?'on':''}" data-k="dom" data-v="${i}">${d}</button>`).join('')}</div>
  <div class="sh"><span>مدة الصلاحية</span></div>
  <div class="seg glass">${[[600,'10 د'],[1800,'30 د'],[3600,'ساعة']].map(([v,l])=>`<button class="${v===settings.life?'on':''}" data-k="life" data-v="${v}">${l}</button>`).join('')}</div>
  <div class="sh"><span>التنبيهات</span></div>
  <div class="grp">
    ${sw('notif',ICO.bell,'إشعارات الرسائل')}
    ${sw('autoCopy',ICO.cp,'نسخ الرموز تلقائياً')}
  </div>
  <div class="sh"><span>حول التطبيق</span></div>
  <div class="grp">
    <div class="row glass"><span class="ic">${ICO.phone}</span><span class="rb"><b>الإصدار</b><span class="r3">v${APP_VERSION}</span></span></div>
    <button class="row glass" data-act="checkUp"><span class="ic">${ICO.dload}</span><span class="rb"><b>فحص التحديثات</b><span class="r3">جلب آخر إصدار من GitHub</span></span></button>
  </div>
  <p class="ft">جميع الطلبات عبر HTTPS. عناوينك محفوظة محلياً على جهازك وتُنسخ احتياطياً عبر Google إن فعّلت المزامنة.</p>`;}
function sw(k,ic,lbl){const on=!!settings[k];return`<div class="row glass"><span class="ic">${ic}</span><span class="rb r2">${lbl}</span><button class="sw${on?' on':''}" role="switch" aria-checked="${on}" data-sw="${k}"></button></div>`;}

/* =========================================================
   Render
   ========================================================= */
function render(anim=true){
  $('#view').innerHTML=[vInbox,vAddrs,vSettings][tab]();
  document.querySelectorAll('.tabs button').forEach((b,j)=>b.classList.toggle('on',j===tab));
  $('#nt').textContent=['الوارد','العناوين','الإعدادات'][tab];
  badge();
  if(anim){$('#view').classList.remove('ent');void $('#view').offsetWidth;$('#view').classList.add('ent');}
  bindView();
}
function badge(){const c=current();if(!c)return;const n=c.msgs.filter(m=>!m.seen).length;const b=$('#bd');b.textContent=n;b.style.display=n?'grid':'none';}
function refreshList(){const l=$('#list');if(!l)return;const c=current();l.innerHTML=c.msgs.length?rows(c.msgs):empty();badge();bindView();}

/* =========================================================
   Mail actions
   ========================================================= */
async function newAddress(silent){
  try{ if(!silent) toast('جاري إنشاء عنوان…');
    const a=await tryCreate(); a.msgs=[]; addrs.unshift(a); curIdx=0; saveAll(); render(); startPolling();
    if(!silent) toast('تم إنشاء عنوان جديد'); setTimeout(poll,4000);
  }catch(e){nlog('error','newAddress: '+e.message);toast('تعذر إنشاء بريد');}
}
async function switchTo(i){curIdx=i;saveAll();render();poll();startPolling();toast('تم التبديل');}
async function poll(){
  const c=current();if(!c)return;const p=PROVIDERS[c.provider];if(!p)return;
  try{
    const list=await p.list(c);
    const known=new Set(c.msgs.map(m=>m.id));
    const added=list.filter(m=>!known.has(m.id));
    c.msgs=list.map(nm=>{const o=c.msgs.find(x=>x.id===nm.id);return o?Object.assign({},nm,{seen:o.seen}):nm;});
    c.msgs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    saveAll(); refreshList();
    for(const m of added){
      if(settings.notif) toast('رسالة جديدة من '+(m.fromName||m.fromAddr));
      if(settings.autoCopy){
        try{const f=await p.read(c,m.id);const code=otp((m.subject||'')+' '+(f.text||'')+' '+(f.html||''));if(code){copy(code);toast('تم نسخ الرمز: '+code);}}catch{}
      }
    }
  }catch(e){nlog('warn','poll: '+e.message);}
}
function startPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(poll,15000);}
async function openMsg(id){
  const c=current();if(!c)return;const p=PROVIDERS[c.provider];if(!p)return;const m=c.msgs.find(x=>x.id===id);if(!m)return;
  try{
    const f=await p.read(c,id);m.seen=true;saveAll();refreshList();
    const code=otp((f.subject||'')+' '+(f.text||'')+' '+(f.html||''));
    const body=f.html?`<iframe sandbox="" style="width:100%;min-height:240px;border:0;border-radius:16px;background:#fff" srcdoc="${esc(safeHtml(f.html))}"></iframe>`:`<p>${esc(f.text||'لا يوجد محتوى').replace(/\n/g,'<br>')}</p>`;
    openSheet(`<div class="sh2"><span class="av" style="--h:${hue(f.fromName||f.fromAddr)}">${esc((f.fromName||f.fromAddr||'?').charAt(0).toUpperCase())}</span>
      <span class="rb"><b>${esc(f.fromName||f.fromAddr||'مجهول')}</b><span class="ltr">${esc(f.fromAddr||'')}</span></span>
      <button class="ib" data-act="close">${ICO.x}</button></div>
      <h2>${esc(f.subject)}</h2><time>${ago(f.createdAt)}</time>${body}
      ${code?`<div class="otp"><small>رمز التحقق</small><div class="code">${code.replace(/(\d{3})(\d{3})/,'$1 $2')}</div><button class="pill pr" data-act="cc" data-c="${code}">${ICO.cp} نسخ الرمز</button></div>`:''}
      <div style="margin-top:18px;display:flex;gap:8px"><button class="pill" style="color:var(--danger);background:rgba(255,92,138,.18)" data-act="del" data-id="${id}">حذف الرسالة</button></div>`);
    const d=$('#sc').querySelector('[data-act="del"]');
    if(d) d.onclick=async()=>{try{await p.remove(c,id);c.msgs=c.msgs.filter(x=>x.id!==id);saveAll();closeSheet();refreshList();toast('تم الحذف');}catch{toast('فشل الحذف');}};
  }catch(e){toast('تعذر فتح الرسالة');nlog('error','openMsg: '+e.message);}
}

/* =========================================================
   Events
   ========================================================= */
function bindView(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=+b.dataset.tab;render();});
  document.querySelectorAll('[data-act]').forEach(b=>{
    if(b._bound)return;b._bound=true;
    b.onclick=()=>{const a=b.dataset.act;
      if(a==='copy'){copy(current().address);toast('تم نسخ العنوان');}
      else if(a==='new')newAddress();
      else if(a==='ext')toast('تم تمديد الصلاحية');
      else if(a==='refresh'){const s=b.querySelector('svg');if(s){s.style.transition='transform .6s';s.style.transform='rotate(360deg)';setTimeout(()=>{s.style.transition='';s.style.transform=''},700);}poll();}
      else if(a==='checkUp'){toast('جاري فحص التحديثات…');checkUpdate(true);}
    };
  });
  document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openMsg(b.dataset.id));
  document.querySelectorAll('[data-ai]').forEach(b=>b.onclick=()=>switchTo(+b.dataset.ai));
  document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{settings[b.dataset.k]=+b.dataset.v;saveSettings();render(false);});
  document.querySelectorAll('[data-sw]').forEach(b=>b.onclick=()=>{const k=b.dataset.sw;settings[k]=settings[k]?0:1;saveSettings();render(false);});
}
$('#scrim').addEventListener('click',closeSheet);
$('#view').addEventListener('scroll',e=>$('#nb').classList.toggle('on',e.target.scrollTop>40));
$('#updateClose').onclick=()=>$('#updateBanner').classList.remove('show');
$('#updateBtn').onclick=()=>openUrl('https://github.com/f0uri/baridat/releases/latest');

/* =========================================================
   OTA update check
   ========================================================= */
async function checkUpdate(manual){
  try{
    let r;
    if(N && N.http){
      r = await http('GET','https://raw.githubusercontent.com/f0uri/baridat/main/public/version.json?t='+Date.now());
    }else{
      r = await new Promise(res=>{const x=new XMLHttpRequest();
        x.open('GET','https://raw.githubusercontent.com/f0uri/baridat/main/public/version.json?t='+Date.now(),true);
        x.onload=()=>res({ok:x.status>=200&&x.status<300,status:x.status,body:x.responseText});
        x.onerror=()=>res({ok:false,status:0});x.send(null);});
    }
    if(!r.ok){if(manual)toast('تعذر الاتصال بخادم التحديثات');return;}
    const d=JSON.parse(r.body);
    if(!d.versionCode||!d.version)return;
    const curVc=(N&&typeof N.getVersionCode==='function')?N.getVersionCode():parseInt(APP_VERSION.split('.').join(''),10);
    const newVc=parseInt(d.versionCode,10);
    if(newVc>curVc){
      const b=$('#updateBanner');
      b.querySelector('.ub-txt').textContent='يتوفر إصدار '+d.version;
      $('#updateBtn').onclick=()=>{openUrl(d.apkUrl||'https://github.com/f0uri/baridat/releases/latest');};
      b.classList.add('show');
      if(manual)toast('يوجد تحديث جديد');
    }else if(manual){
      toast('أنت تستخدم آخر إصدار');
    }
  }catch(e){nlog('warn','ota: '+e.message);if(manual)toast('فشل فحص التحديث');}
}

/* =========================================================
   Boot
   ========================================================= */
async function boot(){
  loadAll();
  render();
  if(!current()){await newAddress(true);}else{poll();}
  startPolling();
  setTimeout(()=>checkUpdate(false),2500);
  setInterval(checkUpdate,6*60*60*1000);
  nlog('info','baridat v'+APP_VERSION+' booted');
}
boot();
