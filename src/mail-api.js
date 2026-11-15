// API Platform deployments can return JSON-LD or plain JSON collections.
export function collection(data) {
  const items = Array.isArray(data) ? data : data?.['hydra:member'] ?? data?.member;
  if (!Array.isArray(items)) throw new Error('استجابة غير متوقعة من خدمة البريد');
  return items;
}

export function apiError(action, response) {
  if (response.status === 0) return new Error(`${action}: تعذر الاتصال بخدمة البريد`);
  if (response.status === 401) return new Error(`${action}: انتهت صلاحية تسجيل الدخول أو لم يعد الحساب متاحاً`);
  if (response.status === 429) return new Error(`${action}: طلبات كثيرة، حاول لاحقاً`);
  return new Error(`${action}: خطأ من خدمة البريد (${response.status})`);
}

export async function mailtmRequest(http, account, method, path) {
  let response = await http(method, 'https://api.mail.tm' + path, null, account.token);
  if (response.status === 401 && account.address && account.password) {
    const login = await http('POST', 'https://api.mail.tm/token', JSON.stringify({address: account.address, password: account.password}));
    if (!login.ok) throw apiError('تسجيل الدخول', login);
    const token = JSON.parse(login.body).token;
    if (!token) throw new Error('تسجيل الدخول: لم تُرجع الخدمة رمز دخول');
    account.token = token;
    response = await http(method, 'https://api.mail.tm' + path, null, token);
  }
  if (!response.ok) throw apiError('جلب البريد', response);
  return response;
}

// Fetch all pages; never replace the inbox with a partial result on failure.
export async function mailtmMessages(http, account) {
  const messages = [];
  for (let page = 1; page <= 100; page++) {
    const response = await mailtmRequest(http, account, 'GET', `/messages?page=${page}`);
    const data = JSON.parse(response.body);
    const items = collection(data);
    messages.push(...items);
    const next = data?.['hydra:view']?.['hydra:next'] ?? data?.view?.next;
    const total = data?.['hydra:totalItems'] ?? data?.totalItems;
    if (next) {
      if (!items.length) throw new Error('تعذر جلب جميع صفحات البريد');
      continue;
    }
    if (Number.isFinite(total) && messages.length < total) {
      if (!items.length) throw new Error('تعذر جلب جميع صفحات البريد');
      continue;
    }
    return messages;
  }
  throw new Error('تعذر جلب جميع صفحات البريد');
}
