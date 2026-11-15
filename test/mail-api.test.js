import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collection, mailtmRequest } from '../src/mail-api.js';

test('accepts supported collection formats and rejects malformed responses', () => {
  for (const value of [[{id: 1}], {'hydra:member': [{id: 1}]}, {member: [{id: 1}]}]) assert.equal(collection(value)[0].id, 1);
  assert.throws(() => collection({error: 'unexpected'}));
});
test('renews an expired token and retries the same request', async () => {
  const calls = [];
  const responses = [{status:401}, {ok:true, body:'{"token":"new"}'}, {ok:true, status:200, body:'{}'}];
  const account = {address:'a@example.com', password:'pw', token:'old'};
  await mailtmRequest(async (...args) => {calls.push(args); return responses.shift();}, account, 'GET', '/messages?page=1');
  assert.equal(account.token, 'new');
  assert.equal(calls[1][1], 'https://api.mail.tm/token');
  assert.equal(calls[2][3], 'new');
});
test('does not silently treat failed requests as an empty inbox', async () => {
  await assert.rejects(mailtmRequest(async () => ({ok:false, status:429}), {}, 'GET', '/messages'), /طلبات كثيرة/);
  await assert.rejects(mailtmRequest(async () => ({ok:false, status:0}), {}, 'GET', '/messages'), /تعذر الاتصال/);
});

test('loads all message pages without silently dropping older messages', async () => {
  const { mailtmMessages } = await import('../src/mail-api.js');
  const paths = [];
  const items = await mailtmMessages(async (_method, url) => {
    paths.push(url);
    const page = paths.length;
    return {ok:true, body:JSON.stringify({'hydra:member': [{id: page}], 'hydra:totalItems': 2})};
  }, {token:'token'});
  assert.deepEqual(items.map(item => item.id), [1, 2]);
  assert.match(paths[1], /page=2/);
});

test('fails rather than returning an incomplete inbox when a later page fails', async () => {
  const { mailtmMessages } = await import('../src/mail-api.js');
  let page = 0;
  await assert.rejects(mailtmMessages(async () => ++page === 1
    ? {ok:true, body:JSON.stringify({member:[{id:1}], totalItems:2})}
    : {ok:false, status:429}, {token:'token'}), /طلبات كثيرة/);
});
