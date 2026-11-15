import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show ImageFilter;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'mail.dart';

const native = MethodChannel('com.baridat.app/native');
const sessionKey = 'baridat_guerrilla_v1';
void main() => runApp(const Baridat());
class Baridat extends StatelessWidget {
  const Baridat({super.key});
  @override Widget build(BuildContext context) => MaterialApp(debugShowCheckedModeBanner: false, locale: const Locale('ar'), supportedLocales: const [Locale('ar')], localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate], theme: ThemeData(useMaterial3: true, brightness: Brightness.light, colorSchemeSeed: const Color(0xff6d28d9), scaffoldBackgroundColor: const Color(0xfff4efff)), darkTheme: ThemeData(useMaterial3: true, brightness: Brightness.dark, colorSchemeSeed: const Color(0xffff6ab8), scaffoldBackgroundColor: const Color(0xff0a0414)), home: const Inbox());
}
class Inbox extends StatefulWidget { const Inbox({super.key}); @override State<Inbox> createState() => _InboxState(); }
class _InboxState extends State<Inbox> with WidgetsBindingObserver {
  late MailService api; Timer? timer; bool busy = false, checking = false, connected = false, sound = true; String status = 'جاري الاتصال…', updateText = ''; List<Map<String,dynamic>> messages = []; String? updateUrl; int tab = 0;
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
    try { final req = await client.getUrl(Uri.parse('https://raw.githubusercontent.com/f0uri/baridat/main/public/version.json')); final response = await req.close(); if (response.statusCode != 200) throw Exception('تعذر التحقق من التحديث'); final json = jsonDecode(await utf8.decoder.bind(response).join()); final code = json['versionCode']; if (code is! int) throw Exception('بيانات التحديث غير صالحة'); setState(() { updateUrl = code > 34 ? json['apkUrl'] : null; updateText = code > 34 ? 'يتوفر تحديث ${json['version']}' : 'التطبيق محدّث'; }); } catch (_) { if (mounted) setState(() => updateText = 'تعذر التحقق من التحديث'); } finally { client.close(force: true); }
  }
  bool get dark => Theme.of(context).brightness == Brightness.dark;
  Color get ink => dark ? const Color(0xfffbf7ff) : const Color(0xff14082b);
  Color get muted => dark ? const Color(0xffb9acd6) : const Color(0xff5a4f78);
  Color get accent => dark ? const Color(0xffff6ab8) : const Color(0xff6d28d9);

  Widget glass({required Widget child, EdgeInsetsGeometry padding = const EdgeInsets.all(16), double radius = 22}) {
    return ClipRRect(borderRadius: BorderRadius.circular(radius), child: BackdropFilter(
      filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
      child: Container(padding: padding, decoration: BoxDecoration(
        color: (dark ? const Color(0xff28193e) : Colors.white).withValues(alpha: dark ? .72 : .72),
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: (dark ? Colors.white : const Color(0xff8b5cf6)).withValues(alpha: dark ? .18 : .14)),
        boxShadow: [BoxShadow(color: const Color(0xff170b38).withValues(alpha: .08), blurRadius: 28, offset: const Offset(0, 10))],
      ), child: child),
    ));
  }
  Widget heading(String text, {Widget? trailing}) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 16, 4, 16),
    child: Row(children: [Expanded(child: Text(text, style: TextStyle(color: ink, fontSize: 34, fontWeight: FontWeight.w700, height: 1.2))), if (trailing != null) trailing]),
  );
  Widget roundAction(IconData icon, String label, VoidCallback? onTap) => Semantics(label: label, button: true, child: Material(
    color: Colors.transparent, child: InkWell(borderRadius: BorderRadius.circular(30), onTap: onTap, child: glass(padding: const EdgeInsets.all(11), radius: 30, child: Icon(icon, color: accent, size: 22))),
  ));
  Widget heroButton(IconData icon, String label, VoidCallback? onTap, {bool primary = false}) => Expanded(child: Padding(
    padding: const EdgeInsets.symmetric(horizontal: 3), child: Material(
      color: primary ? Colors.white : const Color(0xff200031).withValues(alpha: .32), borderRadius: BorderRadius.circular(14),
      child: InkWell(onTap: onTap, borderRadius: BorderRadius.circular(14), child: SizedBox(height: 46, child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(icon, size: 17, color: primary ? const Color(0xff5b21b6) : Colors.white), const SizedBox(width: 5), Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: primary ? const Color(0xff5b21b6) : Colors.white, fontSize: 13, fontWeight: FontWeight.w700)))]))),
    ),
  ));
  void copyAddress() { if (api.session == null) return; feedback(); Clipboard.setData(ClipboardData(text: api.address)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم نسخ العنوان'))); }
  Widget hero() => Container(
    decoration: BoxDecoration(borderRadius: BorderRadius.circular(28), gradient: const LinearGradient(begin: Alignment.topRight, end: Alignment.bottomLeft, colors: [Color(0xff6d28d9), Color(0xffc026d3), Color(0xffe11d48)]), border: Border.all(color: Colors.white.withValues(alpha: .3)), boxShadow: [BoxShadow(color: const Color(0xffc026d3).withValues(alpha: .35), blurRadius: 35, offset: const Offset(0, 18))]),
    padding: const EdgeInsets.fromLTRB(18, 19, 18, 17),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Container(width: 8, height: 8, decoration: BoxDecoration(color: connected ? const Color(0xff42e6a4) : const Color(0xffffcf73), shape: BoxShape.circle)), const SizedBox(width: 8), const Text('عنوانك المؤقت', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600))]),
      const SizedBox(height: 20),
      Text(api.session == null ? 'جاري إنشاء العنوان…' : api.address, textAlign: TextAlign.center, textDirection: TextDirection.ltr, style: const TextStyle(color: Colors.white, fontSize: 17, fontFamily: 'monospace', fontWeight: FontWeight.w700)),
      const SizedBox(height: 15),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(connected ? Icons.check_circle_outline : Icons.info_outline, color: Colors.white.withValues(alpha: .9), size: 17), const SizedBox(width: 7), Flexible(child: Text(status, textAlign: TextAlign.center, style: TextStyle(color: Colors.white.withValues(alpha: .92), fontSize: 12)))]),
      const SizedBox(height: 18),
      Row(children: [heroButton(Icons.copy_rounded, 'نسخ', api.session == null ? null : copyAddress, primary: true), heroButton(Icons.shuffle_rounded, 'عنوان جديد', busy ? null : () { feedback(); action(api.create, clear: true); }), heroButton(Icons.edit_outlined, 'تخصيص', busy || api.session == null ? null : () { feedback(); custom(); })]),
    ]),
  );
  Widget sectionTitle(String title, {String? count}) => Padding(padding: const EdgeInsets.fromLTRB(8, 26, 8, 10), child: Row(children: [Expanded(child: Text(title, style: TextStyle(color: muted, fontSize: 13, fontWeight: FontWeight.w700))), if (count != null) Container(padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3), decoration: BoxDecoration(color: accent.withValues(alpha: .12), borderRadius: BorderRadius.circular(20)), child: Text(count, style: TextStyle(color: ink, fontWeight: FontWeight.bold, fontSize: 12)))]));
  Widget empty() => glass(child: Column(children: [const SizedBox(height: 23), Container(width: 74, height: 74, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: accent.withValues(alpha: .25))), alignment: Alignment.center, child: Container(width: 48, height: 48, decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), gradient: const LinearGradient(colors: [Color(0xff6d28d9), Color(0xffdb2777)])), child: const Icon(Icons.mail_outline_rounded, color: Colors.white))), const SizedBox(height: 18), Text(connected ? 'في انتظار الرسائل' : 'لم يتم التأكد من الوارد', style: TextStyle(color: ink, fontSize: 16, fontWeight: FontWeight.bold)), const SizedBox(height: 6), Text(connected ? 'ستظهر الرسائل الواردة إلى هذا العنوان هنا.' : 'تحقق من حالة الاتصال ثم أعد تحديث الوارد.', textAlign: TextAlign.center, style: TextStyle(color: muted, fontSize: 13)), const SizedBox(height: 24)]));
  Widget messageCard(Map<String,dynamic> m) {
    final from = '${m['mail_from'] ?? 'مرسل غير معروف'}';
    return Padding(padding: const EdgeInsets.only(bottom: 10), child: Material(color: Colors.transparent, child: InkWell(borderRadius: BorderRadius.circular(22), onTap: () { feedback(); open(m); }, child: glass(child: Row(children: [
      Container(width: 46, height: 46, alignment: Alignment.center, decoration: const BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: [Color(0xff843ae8), Color(0xffd42c86)])), child: Text(from.isEmpty ? '?' : from.substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 19))), const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(from, maxLines: 1, overflow: TextOverflow.ellipsis, textDirection: TextDirection.ltr, style: TextStyle(color: ink, fontWeight: FontWeight.w700, fontSize: 14)), const SizedBox(height: 3), Text('${m['mail_subject'] ?? '(بدون موضوع)'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: ink, fontSize: 14)), const SizedBox(height: 3), Text('${m['mail_excerpt'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: muted, fontSize: 12))])), const SizedBox(width: 6), Text('${m['mail_date'] ?? ''}', style: TextStyle(color: muted, fontSize: 10)),
    ])))));
  }
  Widget inboxPage() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    heading('الوارد', trailing: roundAction(Icons.refresh_rounded, 'تحديث الوارد', api.session == null || busy ? null : () { feedback(); refresh(); })), hero(),
    const SizedBox(height: 14),
    Material(color: Colors.transparent, child: InkWell(borderRadius: BorderRadius.circular(22), onTap: () { feedback(); setState(() => tab = 1); }, child: glass(padding: const EdgeInsets.all(14), child: Row(children: [gradientIcon(Icons.alternate_email_rounded), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('إدارة العنوان', style: TextStyle(color: ink, fontWeight: FontWeight.bold)), Text('اختر النطاق أو خصّص عنوانك', style: TextStyle(color: muted, fontSize: 12))])), Icon(Icons.chevron_left_rounded, color: muted)])))),
    sectionTitle('الرسائل', count: '${messages.length}'), if (messages.isEmpty) empty() else ...messages.map(messageCard),
  ]);
  Widget gradientIcon(IconData icon) => Container(width: 42, height: 42, decoration: BoxDecoration(borderRadius: BorderRadius.circular(13), gradient: const LinearGradient(colors: [Color(0xff6d28d9), Color(0xffdb2777)])), child: Icon(icon, color: Colors.white, size: 21));
  Widget addressesPage() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    heading('العناوين', trailing: roundAction(Icons.add_rounded, 'عنوان جديد', busy ? null : () { feedback(); action(api.create, clear: true); })),
    glass(child: Row(children: [gradientIcon(Icons.alternate_email_rounded), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(api.session == null ? 'لا يوجد عنوان' : api.address, textDirection: TextDirection.ltr, style: TextStyle(color: ink, fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis), const SizedBox(height: 4), Text('الرسائل: ${messages.length}', style: TextStyle(color: muted, fontSize: 12))])), Container(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5), decoration: BoxDecoration(color: accent.withValues(alpha: .12), borderRadius: BorderRadius.circular(20)), child: Text('نشط', style: TextStyle(color: accent, fontSize: 12, fontWeight: FontWeight.bold)))])),
    sectionTitle('النطاق'), domainCard(), const SizedBox(height: 14),
    glass(child: Row(children: [gradientIcon(Icons.edit_outlined), const SizedBox(width: 12), Expanded(child: Text('تخصيص اسم البريد', style: TextStyle(color: ink, fontWeight: FontWeight.w600))), TextButton(onPressed: busy || api.session == null ? null : () { feedback(); custom(); }, child: const Text('تعديل'))])),
  ]);
  Widget domainCard() {
    final domain = api.session == null ? null : api.address.split('@').last;
    return glass(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('اختر نطاق البريد', style: TextStyle(color: ink, fontWeight: FontWeight.w600)), const SizedBox(height: 8), DropdownButton<String>(isExpanded: true, value: domains.contains(domain) ? domain : null, hint: Text(domain ?? 'اختر النطاق'), items: domains.map((d) => DropdownMenuItem(value: d, child: Text('@$d', textDirection: TextDirection.ltr))).toList(), onChanged: busy || api.session == null ? null : (d) { if (d != null) { feedback(); action(() => api.domain(d)); } })]));
  }
  Widget settingsPage() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    heading('الإعدادات'), sectionTitle('البريد'), domainCard(), sectionTitle('التفضيلات'),
    glass(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4), child: Row(children: [gradientIcon(Icons.volume_up_outlined), const SizedBox(width: 12), Expanded(child: Text('صوت النقرات', style: TextStyle(color: ink, fontWeight: FontWeight.w600))), Switch(value: sound, activeColor: const Color(0xffc026d3), onChanged: (v) { setState(() => sound = v); native.invokeMethod('save', {'key':'click_sound','value':v ? '1':'0'}); })])),
    sectionTitle('التحديث'), glass(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Row(children: [gradientIcon(Icons.system_update_alt_rounded), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('تحديث التطبيق', style: TextStyle(color: ink, fontWeight: FontWeight.bold)), Text('بريدات 2.8.1', style: TextStyle(color: muted, fontSize: 12))]))]), if (updateText.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(updateText, style: TextStyle(color: muted))), const SizedBox(height: 8), Wrap(spacing: 8, children: [TextButton(onPressed: checkUpdate, child: const Text('التحقق من التحديث')), if (updateUrl != null) TextButton(onPressed: () => native.invokeMethod('downloadUpdate', {'url':updateUrl}), child: const Text('تنزيل وتثبيت')), TextButton(onPressed: () => native.invokeMethod('installUpdate'), child: const Text('تثبيت التحديث المحمّل'))])])),
    Padding(padding: const EdgeInsets.all(12), child: Text('تعتمد مدة الاحتفاظ بالرسائل على خدمة البريد.', style: TextStyle(color: muted, fontSize: 12))),
  ]);
  Widget navigation() => Padding(padding: const EdgeInsets.fromLTRB(22, 0, 22, 12), child: glass(padding: const EdgeInsets.all(6), radius: 30, child: Row(children: List.generate(3, (i) {
    final icons = [Icons.inbox_outlined, Icons.alternate_email_rounded, Icons.settings_outlined]; final labels = ['الوارد', 'العناوين', 'الإعدادات'];
    return Expanded(child: Semantics(button: true, selected: tab == i, label: labels[i], child: Material(color: Colors.transparent, child: InkWell(borderRadius: BorderRadius.circular(21), onTap: () { feedback(); setState(() => tab = i); }, child: AnimatedContainer(duration: const Duration(milliseconds: 220), height: 56, decoration: BoxDecoration(borderRadius: BorderRadius.circular(21), color: tab == i ? accent.withValues(alpha: .13) : Colors.transparent), child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(icons[i], color: tab == i ? accent : muted, size: 21), const SizedBox(height: 2), Text(labels[i], style: TextStyle(color: tab == i ? accent : muted, fontSize: 11, fontWeight: FontWeight.w700))])))));
  }))));
  @override Widget build(BuildContext context) => Scaffold(
    body: Container(decoration: BoxDecoration(color: dark ? const Color(0xff0a0414) : const Color(0xfff4efff)), child: Stack(children: [
      Positioned(top: -140, right: -100, child: orb(const Color(0xfff12f89), 330, .22)),
      Positioned(top: 310, left: -180, child: orb(const Color(0xff8b5cf6), 350, .24)),
      Positioned(bottom: -130, right: -130, child: orb(const Color(0xff22d3ee), 300, .16)),
      SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 430), child: Column(children: [Expanded(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 20), child: [inboxPage, addressesPage, settingsPage][tab]())), navigation()])))),
    ])),
  );
  Widget orb(Color color, double size, double opacity) => IgnorePointer(child: Container(width: size, height: size, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [color.withValues(alpha: opacity), color.withValues(alpha: 0)]))));
}
