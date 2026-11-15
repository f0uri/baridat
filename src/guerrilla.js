export const BASE_URL = 'https://api.guerrillamail.com/ajax.php';
export const DOMAINS = Object.freeze(['sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me', 'guerrillamailblock.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const present = value => typeof value === 'string' && value.trim() !== '';

export function randomName(cryptoObject = globalThis.crypto) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(20);
  while (result.length < 10) {
    cryptoObject.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252) result += alphabet[byte % alphabet.length];
      if (result.length === 10) break;
    }
  }
  return result;
}

export function validName(name) { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,29}$/.test(name); }

// The caller supplies the transport, which is native on Android and fetch on the web.
export class GuerrillaMail {
  constructor(request, onSession = () => {}) {
    this.request = request;
    this.onSession = onSession;
    this.session = null;
    this.queue = Promise.resolve();
  }
  restore(session) { this.session = session; }
  run(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }
  async call(f, params = {}, session = this.session) {
    const query = new URLSearchParams({ f, ...params });
    if (session?.sid_token) query.set('sid_token', session.sid_token);
    const response = await this.request(`${BASE_URL}?${query}`);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('رفضت خدمة البريد الطلب؛ قد تكون الجلسة منتهية أو الخدمة تمنع الاتصال');
      if (response.status === 429) throw new Error('طلبات كثيرة؛ انتظر قليلاً ثم حدّث الوارد');
      throw new Error(response.status ? `تعذر الاتصال بالخدمة (${response.status})` : 'تعذر الاتصال بالخدمة. تحقق من الإنترنت أو قيود المتصفح.');
    }
    let data;
    try { data = JSON.parse(response.body); } catch { throw new Error('استجابة غير صالحة من خدمة البريد'); }
    if (!data || typeof data !== 'object' || data.error || data.auth?.success === false) throw new Error('رفضت خدمة البريد الطلب أو انتهت صلاحية الجلسة');
    return data;
  }
  update(session, data) {
    if (typeof data.sid_token === 'string' && data.sid_token) session.sid_token = data.sid_token;
    if (typeof data.email_addr === 'string' && data.email_addr) session.email_addr = data.email_addr;
    if (!session.sid_token || !session.email_addr) throw new Error('لم تُرجع خدمة البريد جلسة صالحة');
    this.session = session;
    this.onSession(session);
  }
  create(name = randomName()) {
    if (!validName(name)) return Promise.reject(new Error('اسم البريد غير صالح'));
    return this.run(async () => {
      const initial = await this.call('get_email_address', {lang:'en'}, null);
      if (!initial.sid_token || !initial.email_addr) throw new Error('لم تُرجع خدمة البريد جلسة صالحة');
      const session = {sid_token:initial.sid_token, email_addr:initial.email_addr, seen_ids:[], known_ids:[]};
      // Persist the usable session even if the second step fails.
      this.update(session, initial);
      const changed = await this.call('set_email_user', {email_user:name, lang:'en'}, session);
      if (!changed.email_addr) throw new Error('لم تؤكد الخدمة تغيير العنوان');
      this.update(session, changed);
      return session;
    });
  }
  rename(name, site) {
    if (!validName(name)) return Promise.reject(new Error('استخدم 1–30 حرفاً إنجليزياً أو رقماً أو . _ -'));
    if (site && !DOMAINS.includes(site)) return Promise.reject(new Error('نطاق البريد غير مدعوم'));
    return this.run(async () => {
      if (!this.session) throw new Error('لا توجد جلسة بريد');
      const oldName = this.session.email_addr.split('@')[0];
      const data = await this.call('set_email_user', {email_user:name, lang:'en', ...(site ? {site} : {})});
      if (typeof data.email_addr !== 'string' || !data.email_addr.includes('@')) {
        // Preserve a refreshed token even when the server did not confirm the address.
        this.update(this.session, {...data, email_addr:undefined});
        throw new Error('لم تؤكد الخدمة تغيير العنوان');
      }
      const changedName = data.email_addr.split('@')[0].toLowerCase() !== oldName.toLowerCase();
      const session = changedName ? {...this.session, seen_ids:[], known_ids:[]} : {...this.session};
      this.update(session, data);
      const [returnedName, returnedSite] = data.email_addr.split('@');
      if (returnedName.toLowerCase() !== name.toLowerCase() || (site && returnedSite.toLowerCase() !== site.toLowerCase())) {
        throw new Error('لم تؤكد الخدمة الاسم أو النطاق المطلوب؛ يُعرض العنوان الذي أعادته');
      }
      return session;
    });
  }
  list() {
    return this.run(async () => {
      if (!this.session) throw new Error('لا توجد جلسة بريد');
      const data = await this.call('get_email_list', {offset:'0'});
      if (!Array.isArray(data.list)) throw new Error('استجابة قائمة البريد غير صالحة');
      const returnedAddress = data.email || data.email_addr;
      if (typeof returnedAddress === 'string' && returnedAddress && returnedAddress.toLowerCase() !== this.session.email_addr.toLowerCase()) {
        throw new Error('جلسة البريد لم تعد تطابق العنوان المعروض. أنشئ عنواناً جديداً لتجنب فقد الرسائل.');
      }
      this.update(this.session, data);
      return data.list.filter(m => m && m.mail_id != null && !/no-reply@guerrillamail\.com/i.test(String(m.mail_from || '')));
    });
  }
  read(id, delay = wait) {
    return this.run(async () => {
      if (!this.session) throw new Error('لا توجد جلسة بريد');
      const fetchMessage = async () => {
        const data = await this.call('fetch_email', {email_id:String(id)});
        this.update(this.session, data);
        return data;
      };
      const first = await fetchMessage();
      if (present(first.mail_body)) return first;
      await delay(2000);
      const second = await fetchMessage();
      return {...first, ...second, mail_body: present(second.mail_body) ? second.mail_body : (present(second.mail_text) ? second.mail_text : present(first.mail_text) ? first.mail_text : present(second.mail_excerpt) ? second.mail_excerpt : first.mail_excerpt || '')};
    });
  }
}
