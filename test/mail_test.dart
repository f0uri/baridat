import 'package:flutter_test/flutter_test.dart';
import 'package:baridat/mail.dart';
void main() {
  test('domain changes retain the canonical address and session', () async {
    Map<String, dynamic>? saved;
    final api = MailService((value) async { saved = Map.of(value); });
    api.session = {'email_addr':'name@guerrillamailblock.com', 'sid_token':'secret'};
    await api.domain('grr.la');
    expect(api.address, 'name@grr.la');
    expect(saved!['email_addr'], 'name@guerrillamailblock.com');
    expect(saved!['sid_token'], 'secret');
    await expectLater(api.domain('example.com'), throwsException);
  });
}
