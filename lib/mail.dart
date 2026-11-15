import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

const domains = ['sharklasers.com','grr.la','pokemail.net','spam4.me','guerrillamailblock.com','guerrillamail.com','guerrillamail.net','guerrillamail.org','guerrillamail.biz'];

class MailService {
  final Future<void> Function(Map<String, dynamic>) persist;
  Map<String, dynamic>? session;
  Future<void> _tail = Future.value();
  MailService(this.persist);
  Future<T> serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }
  Future<Map<String, dynamic>> call(String fn, [Map<String, String> args = const {}, Map<String, dynamic>? current]) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    final uri = Uri.https('api.guerrillamail.com', '/ajax.php', {'f': fn, ...args, if (current?['sid_token'] != null) 'sid_token': current!['sid_token'].toString(), '_': DateTime.now().microsecondsSinceEpoch.toString()});
    try {
      final request = await client.getUrl(uri).timeout(const Duration(seconds: 20));
      request.headers.set('Cache-Control', 'no-cache, no-store');
      request.headers.set('Accept', 'application/json');
      final response = await request.close().timeout(const Duration(seconds: 20));
      if (response.statusCode != 200) throw Exception('فشل الاتصال بالخدمة (${response.statusCode})');
      final body = await utf8.decoder.bind(response).join().timeout(const Duration(seconds: 20));
      final data = jsonDecode(body);
      if (data is! Map<String, dynamic> || data['error'] != null || (data['auth'] is Map && data['auth']['success'] == false)) throw Exception('رفضت الخدمة الطلب أو انتهت الجلسة');
      return data;
    } finally { client.close(force: true); }
  }
  Future<void> update(Map<String, dynamic> value, Map<String, dynamic> data) async {
    if (data['sid_token'] is String && data['sid_token'].isNotEmpty) value['sid_token'] = data['sid_token'];
    if (data['email_addr'] is String && data['email_addr'].isNotEmpty) value['email_addr'] = data['email_addr'];
    session = value; await persist(value);
  }
  String get address { final s = session!; return '${s['email_addr'].toString().split('@').first}@${s['display_domain'] ?? s['email_addr'].toString().split('@').last}'; }
  Future<void> create() => serial(() async {
    final initial = await call('get_email_address', {'lang':'en'});
    if (initial['sid_token'] is! String || initial['email_addr'] is! String) throw Exception('لم تُرجع الخدمة جلسة صالحة');
    final next = <String,dynamic>{'sid_token':initial['sid_token'],'email_addr':initial['email_addr'],'seen_ids':<String>[], 'known_ids':<String>[]};
    if (session == null) await update(next, initial);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'; final random = Random.secure();
    final name = List.generate(10, (_) => alphabet[random.nextInt(alphabet.length)]).join();
    final changed = await call('set_email_user', {'email_user':name,'lang':'en'}, next);
    if (changed['email_addr'] is! String) throw Exception('لم تؤكد الخدمة الاسم');
    await update(next, changed);
  });
  Future<void> rename(String name) => serial(() async {
    if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,29}$').hasMatch(name)) throw Exception('اسم البريد غير صالح');
    final current = session!;
    final result = await call('set_email_user', {'email_user':name,'lang':'en'}, current);
    if (result['email_addr'] is! String) throw Exception('لم تؤكد الخدمة الاسم');
    final next = {...current, 'seen_ids':<String>[], 'known_ids':<String>[]};
    await update(next, result);
    if (next['email_addr'].toString().split('@').first.toLowerCase() != name.toLowerCase()) throw Exception('لم تؤكد الخدمة الاسم المطلوب');
  });
  Future<void> domain(String value) => serial(() async { if (!domains.contains(value)) throw Exception('نطاق غير مدعوم'); await update({...session!, 'display_domain':value}, {}); });
  Future<List<Map<String,dynamic>>> inbox() => serial(() async {
    final current = session!; final data = await call('get_email_list', {'offset':'0'}, current);
    if (data['list'] is! List) throw Exception('استجابة قائمة البريد غير صالحة');
    final email = data['email'] ?? data['email_addr'];
    if (email is String && email.isNotEmpty && email.toLowerCase() != current['email_addr'].toString().toLowerCase()) throw Exception('الجلسة لا تطابق عنوان البريد');
    await update(current, data);
    return (data['list'] as List).whereType<Map<String,dynamic>>().where((m) => m['mail_id'] != null && !(m['mail_id'].toString() == '1' && (m['mail_from'] ?? '').toString().toLowerCase().contains('no-reply@guerrillamail.com') && (m['mail_subject'] ?? '').toString().toLowerCase().contains('welcome to guerrilla mail'))).toList();
  });
  Future<Map<String,dynamic>> detail(String id) => serial(() async {
    final current = session!; var data = await call('fetch_email', {'email_id':id}, current); await update(current, data);
    if (data['mail_body'] is! String || (data['mail_body'] as String).trim().isEmpty) { await Future<void>.delayed(const Duration(seconds: 2)); final next = await call('fetch_email', {'email_id':id}, current); await update(current, next); data = {...data, ...next}; }
    return data;
  });
}
