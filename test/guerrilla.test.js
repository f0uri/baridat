import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { GuerrillaMail, validName } from '../src/guerrilla.js';
import { extractOtp, parseMessage } from '../src/message.js';

const ok = data => ({ok:true, status:200, body:JSON.stringify(data)});
test('creates a session in two GET requests and uses returned session token', async () => {
  const calls = []; const saved = [];
  const api = new GuerrillaMail(async url => {calls.push(new URL(url)); return calls.length === 1 ? ok({sid_token:'sid+1',email_addr:'first@x.test'}) : ok({sid_token:'sid2',email_addr:'custom@x.test'});}, s => saved.push({...s}));
  const result = await api.create('custom');
  assert.equal(calls[0].searchParams.get('f'), 'get_email_address');
  assert.equal(calls[1].searchParams.get('email_user'), 'custom');
  assert.equal(calls[1].searchParams.get('sid_token'), 'sid+1');
  assert.equal(result.sid_token, 'sid2'); assert.equal(saved.at(-1).email_addr, 'custom@x.test');
});
test('renames in the same session and clears read state', async () => {
  const api = new GuerrillaMail(async url => {assert.equal(new URL(url).searchParams.get('sid_token'),'s');return ok({email_addr:'new@x.test'});});
  api.restore({email_addr:'old@x.test',sid_token:'s',seen_ids:['1'],known_ids:['1']});
  const result = await api.rename('new'); assert.equal(result.sid_token,'s'); assert.deepEqual(result.seen_ids,[]);
  assert.equal(validName('no@domain'),false); assert.equal(validName('a_b-3'),true);
});
test('filters welcome and rejects malformed lists', async () => {
  let malformed = false;
  const api = new GuerrillaMail(async () => ok(malformed ? {} : {list:[{mail_id:1,mail_from:'Guerrilla <no-reply@guerrillamail.com>'},{mail_id:2,mail_from:'someone@example.com'}]}));
  api.restore({email_addr:'a@x.test',sid_token:'s'});
  assert.deepEqual((await api.list()).map(m=>m.mail_id),[2]); malformed = true; await assert.rejects(api.list());
});
test('retries missing body after two seconds and chooses fallback', async () => {
  let count = 0, waited = 0;
  const api = new GuerrillaMail(async () => ok(++count === 1 ? {mail_body:false,mail_text:'backup'} : {mail_body:'',mail_excerpt:'excerpt'}));
  api.restore({email_addr:'a@x.test',sid_token:'s'});
  const result = await api.read('4', async ms => {waited = ms;});
  assert.equal(waited,2000); assert.equal(count,2); assert.equal(result.mail_body,'backup');
});
test('cleans HTML, extracts safe links and prioritizes contextual OTP', () => {
  const doc = new JSDOM('').window.document;
  const result = parseMessage('<style>123456</style><script>evil()</script><p>Invoice 2024</p><p>Verification code: 854321</p><a href="https://example.com/verify?a=1&amp;b=2">Verify</a><a href="https://guerrillamail.com/test">skip</a><a href="https://foo.test/a.jpg?q=1">image</a><a href="javascript:alert(1)">bad</a>', doc);
  assert.doesNotMatch(result.text,/evil|123456/); assert.deepEqual(result.links,['https://example.com/verify?a=1&b=2']);
  assert.equal(extractOtp('Invoice 2024',result.text),'854321');
});

test('request failure does not poison the session queue', async () => {
  let calls = 0;
  const api = new GuerrillaMail(async () => ++calls === 1 ? {ok:false,status:503} : ok({list:[]}));
  api.restore({email_addr:'a@x.test',sid_token:'s',seen_ids:[],known_ids:[]});
  await assert.rejects(api.list(), /503/);
  assert.deepEqual(await api.list(), []);
});
test('uses message body from the second fetch when indexing completes', async () => {
  let calls = 0;
  const api = new GuerrillaMail(async () => ok(++calls === 1 ? {mail_body:false} : {mail_body:'ready'}));
  api.restore({email_addr:'a@x.test',sid_token:'s'});
  assert.equal((await api.read(1, async () => {})).mail_body, 'ready');
});

test('changes domain with site and keeps the current session and read state', async () => {
  let query;
  const saved = [];
  const api = new GuerrillaMail(async url => { query = new URL(url).searchParams; return ok({email_addr:'alex@grr.la',sid_token:'rotated'}); }, s => saved.push(s));
  api.restore({email_addr:'alex@sharklasers.com',sid_token:'original',seen_ids:['11'],known_ids:['11']});
  const result = await api.rename('alex','grr.la');
  assert.equal(query.get('f'), 'set_email_user');
  assert.equal(query.get('site'), 'grr.la');
  assert.equal(query.get('sid_token'), 'original');
  assert.equal(result.sid_token, 'rotated');
  assert.equal(saved.at(-1).email_addr,'alex@grr.la');
  assert.deepEqual(result.seen_ids,['11']); assert.deepEqual(result.known_ids,['11']);
});
test('does not report a successful switch when the server ignores site', async () => {
  const api = new GuerrillaMail(async () => ok({email_addr:'alex@sharklasers.com',sid_token:'new-token'}));
  api.restore({email_addr:'alex@sharklasers.com',sid_token:'old',seen_ids:['1'],known_ids:['1']});
  await assert.rejects(api.rename('alex','grr.la'), /لم تؤكد/);
  assert.equal(api.session.email_addr,'alex@sharklasers.com');
  assert.equal(api.session.sid_token,'new-token');
  assert.deepEqual(api.session.seen_ids,['1']);
});
test('rejects unsupported domains before making a request', async () => {
  let called = false;
  const api = new GuerrillaMail(async () => {called = true;});
  api.restore({email_addr:'a@grr.la',sid_token:'s'});
  await assert.rejects(api.rename('a','evil.example'), /غير مدعوم/);
  assert.equal(called,false);
});
