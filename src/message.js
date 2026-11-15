export function extractOtp(subject, text) {
  const input = `${subject || ''}\n${text || ''}`;
  const matches = [...input.matchAll(/(^|[^0-9])([0-9]{4,8})(?![0-9])/g)].map(m => ({code:m[2], index:m.index + m[1].length}));
  if (!matches.length) return null;
  const words = /code|otp|pin|verif(?:y|ication)|رمز|التحقق|كود|التأكيد/ig;
  const positions = [...input.matchAll(words)].map(m => ({start:m.index, end:m.index + m[0].length}));
  const score = m => Math.min(...positions.map(p => {
    const after = m.index >= p.end;
    const distance = after ? m.index - p.end : Math.abs(p.start - (m.index + m.code.length));
    return distance <= 60 ? distance + (after ? 0 : 30) : Infinity;
  }), Infinity);
  const preferred = matches.map(m => ({m, score:score(m)})).filter(x => Number.isFinite(x.score)).sort((a,b) => a.score-b.score);
  return (preferred[0]?.m || matches[0]).code;
}

export function parseMessage(raw, documentObject = document) {
  // Template content is inert: parsing cannot execute scripts or load remote images.
  const template = documentObject.createElement('template');
  template.innerHTML = String(raw || '');
  const doc = template.content;
  doc.querySelectorAll('script,style,noscript,template,iframe,object,embed,img,svg,math').forEach(el => el.remove());
  const links = new Set();
  function add(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || /(^|\.)guerrillamail\.com$/i.test(url.hostname) || /\.(?:png|jpe?g|gif)(?:$)/i.test(url.pathname)) return;
      links.add(url.href);
    } catch {}
  }
  doc.querySelectorAll('a[href]').forEach(a => add(a.getAttribute('href')));
  const textSource = doc.textContent || '';
  for (const m of textSource.matchAll(/https:\/\/[^\s<>"']+/gi)) add(m[0].replace(/[.,;!?)]+$/, ''));
  doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article').forEach(el => el.append('\n'));
  const text = (doc.textContent || '').replace(/\r/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {text, links:[...links]};
}
