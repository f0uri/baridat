import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

typedef MailTransport = Future<MailResponse> Function(String method, String path, Map<String, dynamic>? body, String? token);
class MailResponse {
  final int status;
  final dynamic data;
  MailResponse(this.status, this.data);
}
class MailException implements Exception {
  final String message;
  const MailException(this.message);
  @override String toString() => message;
}
class _InvalidSession implements Exception {}

Future<MailResponse> _http(String method, String path, Map<String, dynamic>? body, String? token) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  try {
    final uri = Uri.https('api.mail.tm', '/').resolve(path);
    if (uri.scheme != 'https' || uri.host != 'api.mail.tm') throw const MailException('رابط خدمة البريد غير صالح');
    final req = await client.openUrl(method, uri).timeout(const Duration(seconds: 20));
    req.headers.set('Accept', 'application/ld+json, application/json');
    req.headers.set('Cache-Control', 'no-cache, no-store');
    if (token != null) req.headers.set('Authorization', 'Bearer $token');
    if (body != null) { req.headers.contentType = ContentType.json; req.write(jsonEncode(body)); }
    final res = await req.close().timeout(const Duration(seconds: 20));
    final text = await utf8.decoder.bind(res).join().timeout(const Duration(seconds: 20));
    dynamic data;
    try { data = text.isEmpty ? null : jsonDecode(text); } on FormatException { throw const MailException('استجابة غير صالحة من خدمة البريد'); }
    return MailResponse(res.statusCode, data);
  } finally { client.close(force: true); }
}

class MailService {
  final Future<void> Function(Map<String, dynamic>) persist;
  final MailTransport transport;
  Map<String, dynamic>? session;
  List<String> domains = [];
  bool mailboxReplaced = false;
  bool cleanupFailed = false;
  Future<void> _tail = Future.value();
  MailService(this.persist, {MailTransport? transport}) : transport = transport ?? _http;
  Future<T> serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }
  static bool validSession(dynamic s) => s is Map && s['provider'] == 'mail.tm' && s['address'] is String && s['address'].toString().contains('@') && s['password'] is String && s['password'].toString().isNotEmpty && s['id'] is String && s['id'].toString().isNotEmpty && s['token'] is String && s['token'].toString().isNotEmpty;
  String get address => session!['address'] as String;
  List<dynamic>? _members(dynamic data) => data is Map ? (data['hydra:member'] is List ? data['hydra:member'] as List : data['member'] is List ? data['member'] as List : null) : null;
  Future<void> _domains() async {
    final res = await transport('GET', '/domains', null, null);
    if (res.status != 200) throw const MailException('تعذر تحميل نطاقات البريد');
    final members = _members(res.data);
    if (members == null) throw const MailException('تعذر تحميل نطاقات البريد');
    domains = members.whereType<Map>().where((d) => d['isActive'] == true && d['isPrivate'] != true && d['domain'] is String).map((d) => d['domain'] as String).toSet().toList();
    if (domains.isEmpty) throw const MailException('لا توجد نطاقات متاحة حالياً');
  }
  Future<void> loadDomains() => serial(_domains);
  String _random(int length) { const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'; final r = Random.secure(); return List.generate(length, (_) => chars[r.nextInt(chars.length)]).join(); }
  Future<String> _login(String address, String password) async {
    final res = await transport('POST', '/token', {'address':address, 'password':password}, null);
    if (res.status == 401 || res.status == 403 || res.status == 404 || res.status == 422) throw _InvalidSession();
    if (res.status != 200) throw const MailException('تعذر الاتصال بخدمة البريد');
    final token = res.data is Map ? res.data['token'] : null;
    if (token is! String || token.isEmpty) throw _InvalidSession();
    return token;
  }
  Future<void> _delete(Map<String, dynamic> old) async {
    var result = await transport('DELETE', '/accounts/${Uri.encodeComponent(old['id'] as String)}', null, old['token'] as String);
    if (result.status == 401) {
      final token = await _login(old['address'] as String, old['password'] as String);
      result = await transport('DELETE', '/accounts/${Uri.encodeComponent(old['id'] as String)}', null, token);
    }
    if (result.status != 204 && result.status != 200 && result.status != 404) throw const MailException('تعذر حذف العنوان السابق');
  }
  Future<void> _create({String? name, String? domain, bool discard = true}) async {
    if (domains.isEmpty || domain != null && !domains.contains(domain)) await _domains();
    final chosen = domain ?? domains.first;
    if (!domains.contains(chosen)) throw const MailException('النطاق غير متاح');
    final password = _random(32);
    MailResponse? created;
    String address = '';
    for (var attempt = 0; attempt < (name == null ? 3 : 1); attempt++) {
      address = '${name ?? _random(14)}@$chosen';
      created = await transport('POST', '/accounts', {'address':address, 'password':password}, null);
      if (created.status == 201) break;
      if (created.status != 422 || name != null) throw const MailException('تعذر إنشاء العنوان؛ قد يكون الاسم مستخدماً');
    }
    final id = created?.data is Map ? created!.data['id'] : null;
    if (created?.status != 201 || id is! String || id.isEmpty) throw const MailException('تعذر إنشاء العنوان');
    final token = await _login(address, password);
    final next = <String, dynamic>{'provider':'mail.tm', 'address':address, 'password':password, 'id':id, 'token':token};
    final old = session;
    cleanupFailed = false;
    await persist(next);
    session = next;
    if (discard && old != null && validSession(old)) {
      try { await _delete(old); } catch (_) { cleanupFailed = true; }
    }
  }
  Future<void> create() => serial(() => _create());
  Future<void> rename(String name) => serial(() async {
    final clean = name.trim().toLowerCase();
    if (!RegExp(r'^[a-z0-9][a-z0-9._-]{0,29}$').hasMatch(clean)) throw const MailException('اسم البريد غير صالح');
    if (clean == address.split('@').first.toLowerCase()) return;
    await _create(name:clean, domain:address.split('@').last);
  });
  Future<void> domain(String value) => serial(() async {
    if (value == address.split('@').last) return;
    await _create(domain:value);
  });
  Future<void> _relogin() async {
    final s = session!;
    final token = await _login(s['address'] as String, s['password'] as String);
    s['token'] = token;
    await persist(s);
  }
  Future<MailResponse> _authorized(String method, String path) async {
    var res = await transport(method, path, null, session!['token'] as String);
    if (res.status == 401) { await _relogin(); res = await transport(method, path, null, session!['token'] as String); if (res.status == 401) throw _InvalidSession(); }
    return res;
  }
  Future<List<Map<String,dynamic>>> inbox() => serial(() async {
    mailboxReplaced = false;
    try {
      var res = await transport('GET', '/messages', null, session!['token'] as String);
      var reauthenticated = false;
      if (res.status == 401 || (res.status == 200 && _members(res.data) == null)) {
        await _relogin(); reauthenticated = true;
        res = await transport('GET', '/messages', null, session!['token'] as String);
      }
      if (res.status == 401) throw _InvalidSession();
      if (res.status != 200) throw const MailException('تعذر تحديث الوارد');
      var list = _members(res.data);
      if (list == null && reauthenticated) throw _InvalidSession();
      if (list == null) throw const MailException('تعذر تحديث الوارد');
      final all = <Map<String,dynamic>>[...list.whereType<Map<String,dynamic>>()];
      var page = res.data;
      final visited = <String>{};
      while (page is Map) {
        final view = page['hydra:view'] ?? page['view'];
        final next = view is Map ? (view['hydra:next'] ?? view['next']) : null;
        if (next is! String || next.isEmpty) break;
        final uri = Uri.tryParse(next);
        if (uri == null || (uri.hasAuthority && (uri.scheme != 'https' || uri.host != 'api.mail.tm')) || uri.path != '/messages' || !visited.add(next) || visited.length > 100) throw const MailException('تعذر تحميل كامل الوارد');
        final more = await _authorized('GET', next);
        if (more.status != 200 || _members(more.data) == null) throw const MailException('تعذر تحميل كامل الوارد');
        all.addAll(_members(more.data)!.whereType<Map<String,dynamic>>());
        page = more.data;
      }
      return all.map(_summary).toList();
    } on _InvalidSession {
      // Don't delete the old account; failed authentication does not prove it is gone.
      await _create(discard:false);
      mailboxReplaced = true;
      return [];
    }
  });
  Map<String,dynamic> _summary(Map<String,dynamic> m) {
    final from = m['from'];
    final sender = from is Map ? [from['name'], from['address']].whereType<String>().where((v) => v.isNotEmpty).join(' · ') : '';
    return {'mail_id':m['id'], 'mail_from':sender, 'mail_subject':m['subject'] ?? '', 'mail_excerpt':m['intro'] ?? '', 'mail_date':m['createdAt'] ?? ''};
  }
  Future<Map<String,dynamic>> detail(String id) => serial(() async {
    try {
      final res = await _authorized('GET', '/messages/${Uri.encodeComponent(id)}');
      if (res.status != 200 || res.data is! Map<String,dynamic>) throw const MailException('تعذر فتح الرسالة');
      final data = res.data as Map<String,dynamic>;
      final html = data['html'];
      return {..._summary(data), 'mail_text':data['text'], 'mail_body':html is List ? html.whereType<String>().join('\n') : html};
    } on _InvalidSession { throw const MailException('تعذر فتح الرسالة؛ أعد تحديث الوارد'); }
  });
}

/// Choose the first candidate that contains text after removing HTML markup.
String messageBody(Iterable<dynamic> candidates) {
  for (final candidate in candidates) {
    if (candidate is! String) continue;
    final clean = candidate.replaceAll(RegExp(r'<(script|style|head)\b[^>]*>[\s\S]*?</\1\s*>', caseSensitive: false), ' ')
      .replaceAll(RegExp(r'<br\s*/?>|</(?:p|div|li|tr)>', caseSensitive: false), '\n')
      .replaceAll(RegExp(r'<[^>]*>'), ' ')
      .replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>').replaceAll('&quot;', '"').trim();
    if (clean.isNotEmpty) return clean;
  }
  return 'المحتوى غير متاح حالياً.';
}
