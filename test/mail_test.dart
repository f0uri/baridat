import 'package:flutter_test/flutter_test.dart';
import 'package:baridat/mail.dart';

void main() {
  test('creates real account credentials, logs in and persists', () async {
    final calls = <String>[]; Map<String,dynamic>? saved;
    final api = MailService((s) async { saved = Map.of(s); }, transport: (method, path, body, token) async {
      calls.add('$method $path');
      if (path == '/domains') return MailResponse(200, {'hydra:member':[{'domain':'example.test','isActive':true,'isPrivate':false}]});
      if (path == '/accounts') { expect(body!['password'], isNotEmpty); return MailResponse(201, {'id':'account1'}); }
      if (path == '/token') return MailResponse(200, {'token':'jwt'});
      throw StateError('unexpected request');
    });
    await api.create();
    expect(calls, ['GET /domains','POST /accounts','POST /token']);
    expect(saved!['address'], endsWith('@example.test'));
    expect(saved!['password'].length, 32);
    expect(saved!['token'], 'jwt');
  });
  test('relogs on 401 and maps Gmail list and full content', () async {
    var requests = 0, logins = 0;
    final api = MailService((_) async {}, transport: (method, path, body, token) async {
      if (path == '/token') { logins++; return MailResponse(200, {'token':'fresh'}); }
      if (path == '/messages') { requests++; if (requests == 1) return MailResponse(401, {}); expect(token, 'fresh'); return MailResponse(200, {'hydra:member':[{'id':'m1','from':{'address':'sender@gmail.com'},'subject':'اختبار بريدات','intro':'رسالة اختبار','createdAt':'now'}]}); }
      if (path == '/messages/m1') return MailResponse(200, {'id':'m1','from':{'address':'sender@gmail.com'},'subject':'اختبار بريدات','text':'رسالة اختبار لتطبيق بريدات.','html':['<p>رسالة</p>']});
      throw StateError('unexpected');
    });
    api.session = {'provider':'mail.tm','address':'a@example.test','password':'pw','id':'a','token':'old'};
    final list = await api.inbox();
    expect(logins, 1); expect(list.single['mail_subject'], 'اختبار بريدات');
    expect(list.single['mail_from'], 'sender@gmail.com');
    final full = await api.detail('m1'); expect(full['mail_text'], 'رسالة اختبار لتطبيق بريدات.');
  });
  test('malformed list relogs once then creates a fresh account on invalid credentials', () async {
    var logins = 0;
    final api = MailService((_) async {}, transport: (method, path, body, token) async {
      if (path == '/messages') return MailResponse(200, {});
      if (path == '/token') { logins++; return logins == 1 ? MailResponse(401, {}) : MailResponse(200, {'token':'new'}); }
      if (path == '/domains') return MailResponse(200, {'member':[{'domain':'example.test','isActive':true}]});
      if (path == '/accounts') return MailResponse(201, {'id':'newid'});
      throw StateError('unexpected');
    });
    api.session = {'provider':'mail.tm','address':'old@example.test','password':'pw','id':'old','token':'old'};
    expect(await api.inbox(), isEmpty); expect(api.mailboxReplaced, isTrue); expect(api.session!['id'], 'newid'); expect(logins, 2);
  });
  test('network errors do not replace an existing mailbox', () async {
    final api = MailService((_) async {}, transport: (method, path, body, token) async => MailResponse(503, {}));
    api.session = {'provider':'mail.tm','address':'old@example.test','password':'pw','id':'old','token':'old'};
    await expectLater(api.inbox(), throwsA(isA<MailException>()));
    expect(api.session!['id'], 'old');
  });
  test('new address deletes the discarded account after creating the replacement', () async {
    final calls = <String>[];
    final api = MailService((_) async {}, transport: (method, path, body, token) async {
      calls.add('$method $path');
      if (path == '/accounts' && method == 'POST') return MailResponse(201, {'id':'newid'});
      if (path == '/token') return MailResponse(200, {'token':'new'});
      if (path == '/accounts/old' && method == 'DELETE') return MailResponse(204, null);
      throw StateError('unexpected');
    });
    api.domains = ['example.test']; api.session = {'provider':'mail.tm','address':'old@example.test','password':'pw','id':'old','token':'old'};
    await api.rename('newname');
    expect(api.address, 'newname@example.test'); expect(calls.last, 'DELETE /accounts/old');
  });
  test('empty markup falls back after stripping, not before', () {
    expect(messageBody(['<pre></pre>', '', '']), 'المحتوى غير متاح حالياً.');
    expect(messageBody(['<pre></pre>', 'Full message']), 'Full message');
  });
  test('loads every page of inbox', () async {
    final api = MailService((_) async {}, transport: (method, path, body, token) async {
      if (path == '/messages') return MailResponse(200, {'hydra:member':[{'id':'a'}], 'hydra:view':{'hydra:next':'/messages?page=2'}});
      if (path == '/messages?page=2') return MailResponse(200, {'hydra:member':[{'id':'b'}]});
      throw StateError('unexpected');
    });
    api.session = {'provider':'mail.tm','address':'a@example.test','password':'pw','id':'a','token':'jwt'};
    expect((await api.inbox()).map((m) => m['mail_id']), ['a','b']);
  });

}
