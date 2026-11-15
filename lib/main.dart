import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'mail.dart';

const native = MethodChannel('com.baridat.app/native');
const sessionKey = 'baridat_guerrilla_v1';
void main() => runApp(const Baridat());
class Baridat extends StatelessWidget {
  const Baridat({super.key});
  @override Widget build(BuildContext context) => MaterialApp(debugShowCheckedModeBanner: false, locale: const Locale('ar'), supportedLocales: const [Locale('ar')], localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate], theme: ThemeData.dark(useMaterial3: true).copyWith(colorScheme: const ColorScheme.dark(primary: Color(0xff64d6ef), surface: Color(0xff141e30))), home: const Inbox());
}
class Inbox extends StatefulWidget { const Inbox({super.key}); @override State<Inbox> createState() => _InboxState(); }
class _InboxState extends State<Inbox> with WidgetsBindingObserver {
  late MailService api; Timer? timer; bool busy = false, checking = false, connected = false, sound = true; String status = 'جاري الاتصال…', updateText = ''; List<Map<String,dynamic>> messages = []; String? updateUrl;
  @override void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); api = MailService((s) async { await native.invokeMethod('save', {'key':sessionKey,'value':jsonEncode(s)}); }); native.setMethodCallHandler((call) async { if (call.method == 'updateStatus' && mounted) { final d = jsonDecode(call.arguments as String); setState(() => updateText = d['message'] ?? ''); } }); init(); }
  Future<void> init() async {
    try {
      final raw = await native.invokeMethod<String>('load', {'key':sessionKey});
      if (raw != null) { final value = jsonDecode(raw); if (value is Map<String,dynamic> && value['email_addr'] is String && value['sid_token'] is String && value['email_addr'].toString().contains('@')) api.session = value; }
      sound = (await native.invokeMethod<String>('load', {'key':'click_sound'})) != '0';
      if (api.session == null) await api.create();
      await refresh();
    } catch (e) { if (mounted) setState(() { connected = false; status = error(e); }); }
    timer = Timer.periodic(const Duration(seconds: 6), (_) { if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) refresh(); });
    if (mounted) setState(() {});
  }
  String error(Object e) => e.toString().replaceFirst('Exception: ', '');
  @override void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) refresh(); }
  @override void dispose() { timer?.cancel(); WidgetsBinding.instance.removeObserver(this); super.dispose(); }
  void feedback() { if (sound) SystemSound.play(SystemSoundType.click); }
  Future<void> refresh() async {
    if (api.session == null || busy || checking) return;
    checking = true; final target = api.session;
    try { final data = await api.inbox(); if (mounted && identical(target, api.session) && !busy) setState(() { messages = data; connected = true; status = 'تم فحص الوارد · كل ٦ ثوانٍ'; }); }
    catch (e) { if (mounted && identical(target, api.session)) setState(() { connected = false; status = error(e); }); }
    finally { checking = false; }
  }
  Future<void> action(Future<void> Function() f, {bool clear = false}) async {
    if (busy) return; setState(() => busy = true);
    try { await f(); if (clear) messages = []; } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error(e)))); }
    finally { if (mounted) setState(() => busy = false); }
    await refresh();
  }
  Future<void> custom() async { final controller = TextEditingController(text: api.session?['email_addr'].toString().split('@').first); final name = await showDialog<String>(context: context, builder: (c) => AlertDialog(title: const Text('تخصيص عنوان البريد'), content: TextField(controller: controller, textDirection: TextDirection.ltr, maxLength: 30), actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('إلغاء')), TextButton(onPressed: () => Navigator.pop(c, controller.text.trim()), child: const Text('حفظ'))])); if (name != null) await action(() => api.rename(name), clear: true); }
  Future<void> open(Map<String,dynamic> item) async {
    final target = api.session;
    try { final full = await api.detail(item['mail_id'].toString()); if (!mounted || !identical(target, api.session)) return;
      String text(dynamic x) => x is String && x.trim().isNotEmpty ? x : '';
      final raw = [text(full['mail_body']), text(full['mail_text']), text(full['mail_excerpt']), text(item['mail_excerpt'])].firstWhere((x) => x.isNotEmpty, orElse: () => 'المحتوى غير متاح حالياً.');
      final plain = raw.replaceAll(RegExp(r'<(script|style|head)\b[^>]*>[\s\S]*?</\1\s*>', caseSensitive: false), ' ').replaceAll(RegExp(r'<br\s*/?>|</(?:p|div|li|tr)>', caseSensitive: false), '\n').replaceAll(RegExp(r'<[^>]*>'), ' ').replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
      final code = RegExp(r'(?:code|otp|pin|verification|رمز|التحقق|كود)[^0-9]{0,25}([0-9]{4,8})', caseSensitive: false).firstMatch('${full['mail_subject'] ?? ''} $plain')?.group(1) ?? RegExp(r'\b[0-9]{4,8}\b').firstMatch(plain)?.group(0);
      final urls = RegExp(r'''https?://[^\s<>"']+''', caseSensitive: false).allMatches(raw.replaceAll('&amp;', '&')).map((m) => m.group(0)!).where((u) => Uri.tryParse(u)?.host.isNotEmpty == true).toSet().take(10).toList();
      if (!mounted) return; showModalBottomSheet(context: context, isScrollControlled: true, builder: (c) => SafeArea(child: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(24), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [Text('${full['mail_subject'] ?? item['mail_subject'] ?? '(بدون موضوع)'}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)), const SizedBox(height: 8), Text('${full['mail_from'] ?? item['mail_from'] ?? ''}'), if (code != null) ...[const SizedBox(height: 16), FilledButton(onPressed: () { Clipboard.setData(ClipboardData(text: code)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم نسخ الرمز'))); }, child: Text('نسخ رمز التحقق  $code'))], const SizedBox(height: 20), SelectableText(plain), if (urls.isNotEmpty) const Padding(padding: EdgeInsets.only(top: 20), child: Text('تحقق من الرابط قبل فتحه:')), ...urls.map((url) => TextButton(onPressed: () => native.invokeMethod('openUrl', {'url':url}), child: Text(url, textDirection: TextDirection.ltr)))])))));
    } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error(e)))); }
  }
  Future<void> checkUpdate() async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try { final req = await client.getUrl(Uri.parse('https://raw.githubusercontent.com/f0uri/baridat/main/public/version.json')); final response = await req.close(); if (response.statusCode != 200) throw Exception('تعذر التحقق من التحديث'); final json = jsonDecode(await utf8.decoder.bind(response).join()); final code = json['versionCode']; if (code is! int) throw Exception('بيانات التحديث غير صالحة'); setState(() { updateUrl = code > 33 ? json['apkUrl'] : null; updateText = code > 33 ? 'يتوفر تحديث ${json['version']}' : 'التطبيق محدّث'; }); } catch (_) { if (mounted) setState(() => updateText = 'تعذر التحقق من التحديث'); } finally { client.close(force: true); }
  }
  @override Widget build(BuildContext context) {
    final s = api.session; final domain = s == null ? null : api.address.split('@').last;
    return Scaffold(body: Container(decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xff070b15),Color(0xff152038),Color(0xff080d18)])), child: SafeArea(child: Padding(padding: const EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [const Expanded(child: Text('بريدات', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold))), IconButton(onPressed: () => showModalBottomSheet(context: context, builder: (c) => StatefulBuilder(builder: (c, update) => SafeArea(child: Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, children: [SwitchListTile(title: const Text('صوت النقرات'), value: sound, onChanged: (v) { setState(() => sound = v); update(() {}); native.invokeMethod('save', {'key':'click_sound','value':v ? '1':'0'}); }), TextButton(onPressed: () async { await checkUpdate(); update(() {}); }, child: const Text('التحقق من التحديث')), Text(updateText), if (updateUrl != null) FilledButton(onPressed: () => native.invokeMethod('downloadUpdate', {'url':updateUrl}), child: const Text('تنزيل وتثبيت التحديث')), TextButton(onPressed: () => native.invokeMethod('installUpdate'), child: const Text('تثبيت التحديث المحمّل'))])))), icon: const Icon(Icons.settings_outlined))]),
      Text(status, style: TextStyle(color: connected ? Colors.tealAccent : Colors.orangeAccent)), const SizedBox(height: 18),
      Card(color: Colors.white.withValues(alpha: .07), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24), side: BorderSide(color: Colors.white.withValues(alpha: .15))), child: Padding(padding: const EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const Text('عنوانك المؤقت', style: TextStyle(color: Colors.white70)), const SizedBox(height: 8), SelectableText(s == null ? 'جاري إنشاء العنوان…' : api.address, textDirection: TextDirection.ltr, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)), DropdownButton<String>(isExpanded: true, value: domains.contains(domain) ? domain : null, hint: Text(domain ?? 'اختر النطاق'), items: domains.map((d) => DropdownMenuItem(value: d, child: Text('@$d', textDirection: TextDirection.ltr))).toList(), onChanged: busy || s == null ? null : (d) { if (d != null) action(() => api.domain(d)); }), Wrap(alignment: WrapAlignment.spaceBetween, children: [TextButton.icon(onPressed: s == null ? null : () { feedback(); Clipboard.setData(ClipboardData(text: api.address)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم النسخ'))); }, icon: const Icon(Icons.copy), label: const Text('نسخ')), TextButton.icon(onPressed: busy ? null : () { feedback(); action(api.create, clear: true); }, icon: const Icon(Icons.shuffle), label: const Text('تغيير')), TextButton.icon(onPressed: busy || s == null ? null : () { feedback(); custom(); }, icon: const Icon(Icons.edit_outlined), label: const Text('تخصيص')), TextButton.icon(onPressed: busy || s == null ? null : () { feedback(); refresh(); }, icon: const Icon(Icons.refresh), label: const Text('تحديث'))])]))),
      const SizedBox(height: 20), Text('صندوق الوارد (${messages.length})', style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold)), const SizedBox(height: 10), Expanded(child: messages.isEmpty ? Center(child: Text(connected ? 'في انتظار وصول الرسائل…' : 'لم يتم التأكد من الوارد، تحقق من الاتصال', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70))) : ListView.builder(itemCount: messages.length, itemBuilder: (_, i) { final m = messages[i]; return Card(color: Colors.white.withValues(alpha: .07), child: ListTile(onTap: () { feedback(); open(m); }, leading: const CircleAvatar(child: Icon(Icons.mail_outline)), title: Text('${m['mail_subject'] ?? '(بدون موضوع)'}'), subtitle: Text('${m['mail_from'] ?? ''}\n${m['mail_excerpt'] ?? ''}', maxLines: 3, overflow: TextOverflow.ellipsis), isThreeLine: true)); }))
    ])))));
  }
}
