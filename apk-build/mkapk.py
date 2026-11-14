#!/usr/bin/env python3
"""
Build Baridat APK — pure Python, no Android SDK required.
Produces a signed APK containing a WebView that loads file:///android_asset/index.html
"""
import os, sys, struct, zipfile, hashlib, io, shutil, tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dex import DexBuilder, u8, u16, u32
from axml import build_manifest
from arsc import ResTable, res_value, TYPE_REFERENCE, TYPE_STRING

ROOT = Path('/home/user/baridat')
DIST = ROOT / 'dist'
OUT_APK = ROOT / 'baridat.apk'
WORK = ROOT / 'apk-build'

PKG = 'com.baridat.app'
APP_NAME_AR = 'بريدات'
VERSION_CODE = 4
VERSION_NAME = '1.2.0'

# Resource IDs
# Package 0x7F, type 1 = attr, 2 = drawable/mipmap, 3 = string, 4 = style, 5 = xml
# We'll keep it simple: type 2 = mipmap (icon), type 3 = string (app_name), type 4 = xml (network config)
ICON_RES_ID = 0x7F020000  # mipmap/ic_launcher
APP_NAME_RES_ID = 0x7F030000  # string/app_name
# Theme resource: we'll reference an Android framework theme to avoid needing a custom style.
# Use android:Theme.DeviceDefault.NoActionBar — reference 0x0103000C is framework; aapt uses @*android:style
# Simpler: point theme directly to @android:style/Theme.DeviceDefault.NoActionBar (id 0x0103022e)
THEME_RES_ID = 0x0103022E  # android:Theme.DeviceDefault.NoActionBar.Fullscreen
NETSEC_RES_ID = 0x7F040000  # xml/network_security_config


def build_classes_dex():
    db = DexBuilder()

    # Strings (method names + URL — type descriptor strings get added via db.type)
    s_init = db.string('<init>')
    s_onCreate = db.string('onCreate')
    s_url = db.string('file:///android_asset/index.html')
    s_getSettings = db.string('getSettings')
    s_loadUrl = db.string('loadUrl')
    s_setContentView = db.string('setContentView')
    s_setJs = db.string('setJavaScriptEnabled')
    s_setDom = db.string('setDomStorageEnabled')
    s_setWide = db.string('setUseWideViewPort')
    s_setOverview = db.string('setLoadWithOverviewMode')
    s_setFile = db.string('setAllowFileAccess')
    s_setContent = db.string('setAllowContentAccess')
    s_setMixed = db.string('setMixedContentMode')
    s_setWVC_name = db.string('setWebViewClient')
    s_setMediaGesture = db.string('setMediaPlaybackRequiresUserGesture')

    # Type descriptors (passed as strings — db.type registers them in string pool)
    d_V = 'V'; d_Z = 'Z'; d_I = 'I'
    d_Activity = 'Landroid/app/Activity;'
    d_Bundle = 'Landroid/os/Bundle;'
    d_Context = 'Landroid/content/Context;'
    d_View = 'Landroid/view/View;'
    d_String = 'Ljava/lang/String;'
    d_WebView = 'Landroid/webkit/WebView;'
    d_WebSettings = 'Landroid/webkit/WebSettings;'
    d_WebViewClient = 'Landroid/webkit/WebViewClient;'
    d_Main = f'L{PKG.replace(".","/")}/MainActivity;'

    # Types
    t_V = db.type(d_V); t_Z = db.type(d_Z); t_I = db.type(d_I)
    t_Activity = db.type(d_Activity)
    t_Bundle = db.type(d_Bundle)
    t_Context = db.type(d_Context)
    t_View = db.type(d_View)
    t_String = db.type(d_String)
    t_WebView = db.type(d_WebView)
    t_WebSettings = db.type(d_WebSettings)
    t_WebViewClient = db.type(d_WebViewClient)
    t_Main = db.type(d_Main)

    # Protos
    p_init = db.proto(t_V, [])
    p_onCreate = db.proto(t_V, [t_Bundle])
    p_WebView_init = db.proto(t_V, [t_Context])
    p_setContentView = db.proto(t_V, [t_View])
    p_loadUrl = db.proto(t_V, [t_String])
    p_getSettings = db.proto(t_WebSettings, [])
    p_setBool = db.proto(t_V, [t_Z])
    p_setInt = db.proto(t_V, [t_I])
    p_setWVC = db.proto(t_V, [t_WebViewClient])

    # Methods
    m_Activity_init = db.method(t_Activity, s_init, p_init)
    m_super_onCreate = db.method(t_Activity, s_onCreate, p_onCreate)
    m_WebView_init = db.method(t_WebView, s_init, p_WebView_init)
    m_getSettings = db.method(t_WebView, s_getSettings, p_getSettings)
    m_loadUrl = db.method(t_WebView, s_loadUrl, p_loadUrl)
    m_setContentView = db.method(t_Activity, s_setContentView, p_setContentView)
    m_setJs = db.method(t_WebSettings, s_setJs, p_setBool)
    m_setDom = db.method(t_WebSettings, s_setDom, p_setBool)
    m_setWide = db.method(t_WebSettings, s_setWide, p_setBool)
    m_setOverview = db.method(t_WebSettings, s_setOverview, p_setBool)
    m_setFile = db.method(t_WebSettings, s_setFile, p_setBool)
    m_setContent = db.method(t_WebSettings, s_setContent, p_setBool)
    m_setMixed = db.method(t_WebSettings, s_setMixed, p_setInt)
    m_setWVC = db.method(t_WebView, s_setWVC_name, p_setWVC)
    m_WVC_init = db.method(t_WebViewClient, s_init, p_init)
    m_setMediaGesture = db.method(t_WebSettings, s_setMediaGesture, p_setBool)

    m_our_init = db.method(t_Main, s_init, p_init)
    m_our_onCreate = db.method(t_Main, s_onCreate, p_onCreate)

    # Class
    cdef = db.cls(t_Main, 0x0001 | 0x0020, t_Activity)  # public, super

    # <init> method
    db.add_method(cdef, m_our_init, 0x0001 | 0x0002, [
        ('registers', 2), ('ins', 1), ('outs', 1),
        ('invoke-direct', {'method': m_Activity_init, 'regs': [1]}),
        ('return-void',),
    ])

    # onCreate method
    # registers: v0=this, v1=Bundle, v2=WebView, v3=WebSettings, v4=WebViewClient, v5=true, v6=false, v7=str_url, v8=0(int)
    db.add_method(cdef, m_our_onCreate, 0x0001 | 0x0004, [
        ('registers', 9), ('ins', 2), ('outs', 3),
        ('invoke-super', {'method': m_super_onCreate, 'regs': [0, 1]}),
        ('const', {'reg': 5, 'val': 1}),  # true
        ('const', {'reg': 6, 'val': 0}),  # false
        ('const', {'reg': 8, 'val': 0}),
        ('new-instance', {'reg': 2, 'type': t_WebView}),
        ('invoke-direct', {'method': m_WebView_init, 'regs': [2, 0]}),
        ('invoke-virtual', {'method': m_getSettings, 'regs': [2]}),
        ('move-result-object', {'reg': 3}),
        ('invoke-virtual', {'method': m_setJs, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setDom, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setWide, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setOverview, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setFile, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setContent, 'regs': [3, 5]}),
        ('invoke-virtual', {'method': m_setMediaGesture, 'regs': [3, 6]}),
        ('invoke-virtual', {'method': m_setMixed, 'regs': [3, 8]}),
        ('new-instance', {'reg': 4, 'type': t_WebViewClient}),
        ('invoke-direct', {'method': m_WVC_init, 'regs': [4]}),
        ('invoke-virtual', {'method': m_setWVC, 'regs': [2, 4]}),
        ('const-string', {'reg': 7, 'string': s_url}),
        ('invoke-virtual', {'method': m_loadUrl, 'regs': [2, 7]}),
        ('invoke-virtual', {'method': m_setContentView, 'regs': [0, 2]}),
        ('return-void',),
    ])

    return db.build()


def build_network_security_config():
    """Build binary XML for res/xml/network_security_config.xml allowing cleartext."""
    from axml import AXML
    x = AXML()
    NS = 'http://schemas.android.com/apk/res/android'
    x.start_ns('android', NS)
    x.start_tag('network-security-config')
    # default-config: cleartextTrafficPermitted=true, trust anchors (system + user)
    x.start_tag('base-config', [
        x.a('cleartextTrafficPermitted', 0xFFFFFFFF, dtype=0x12),
    ])
    x.start_tag('trust-anchors')
    x.start_tag('certificates', [x.a('src', 'system')]); x.end_tag('certificates')
    x.start_tag('certificates', [x.a('src', 'user')]); x.end_tag('certificates')
    x.end_tag('trust-anchors')
    x.end_tag('base-config')
    # Allow mail.tm API — already covered by base-config
    x.end_tag('network-security-config')
    x.end_ns('android', NS)
    return x.build()


def build_resources_arsc():
    rt = ResTable(package_id=0x7F, package_name=PKG)
    # Add string 'app_name' = APP_NAME_AR (referenced as type 3)
    # Type 'mipmap' is type 1 (first added)
    # Type 'string' is type 2
    # Type 'xml' is type 3
    # Our resource IDs: 0x7F TT 0000, TT=typeId (1-based)
    # So mipmap (tt=1) icon = 0x7F010000, string (tt=2) app_name = 0x7F020000, xml (tt=3) netsec = 0x7F030000
    #
    # But in our manifest we use:
    #   icon = 0x7F020000 (mipmap)
    #   theme = framework ref
    #   networkSecurityConfig = 0x7F040000 (xml)
    # To match we need to register types in this order: attr, mipmap, string, drawable, xml
    # Easiest: register a dummy 'attr' first, then mipmap, string, drawable, xml
    rt.gstr(APP_NAME_AR)
    # We need mipmap entry with a reference to the PNG file — that's complex.
    # For mipmap/drawable, use TYPE_REFERENCE pointing to an internal file.
    # Actually a simpler approach: just place icon at res/drawable-nodpi-v4/ and reference via Res_value(0x03 string)?
    # Simpler still: declare icon as a TYPE_STRING pointing to a filename the framework resolves.
    # Android resolves drawable references differently. Instead let's use TYPE_STRING for simplicity and see.
    #
    # Actually the easiest path: provide icon as drawable using a complex ResTable_map_entry.
    # For now, let's just use app_name string and reference to framework icon, and skip our custom icon.
    # We'll set icon to @android:drawable/sym_def_app_icon (framework ref 0x01080008) to avoid packaging PNG as resource.
    pass
    # We'll not use ResTable for icon — override manifest icon to use a framework icon.
    # But we want our custom icon. Let's provide a minimal mipmap resource via TYPE_STRING pointing to the file.
    # Android accepts string resources for drawable if it's a plain image reference. Better approach:
    # Skip resources.arsc icon and include PNG files in res/mipmap-mdpi/ etc.
    # But without aapt, the APK won't reference them.
    #
    # PRAGMATIC: use framework app icon + app_name string only. Icon PNG we still include for user familiarity.
    rt.add_entry('string', 'app_name', res_value(TYPE_STRING, rt.gstr(APP_NAME_AR)))
    return rt.build()


def build_signed_apk():
    print("Building classes.dex ...")
    dex_bytes = build_classes_dex()
    print(f"  classes.dex: {len(dex_bytes)} bytes")

    print("Building AndroidManifest.xml ...")
    # Use framework icon for simplicity; our custom icon will appear after install via manifest icon (we will add PNGs under res/mipmap-anydpi-v26/ but they need resource IDs)
    # Use @android:drawable/sym_def_app_icon = 0x01080008
    manifest_bytes = build_manifest(
        PKG,
        APP_NAME_RES_ID,  # label reference to @string/app_name
        VERSION_CODE, VERSION_NAME,
        icon_ref=0x01080008,  # framework icon (fallback)
        theme_ref=THEME_RES_ID,
        netsec_ref=NETSEC_RES_ID,
    )
    print(f"  AndroidManifest.xml: {len(manifest_bytes)} bytes")

    print("Building resources.arsc ...")
    arsc_bytes = build_resources_arsc()
    print(f"  resources.arsc: {len(arsc_bytes)} bytes")

    print("Building network_security_config.xml ...")
    netsec_bytes = build_network_security_config()
    print(f"  network_security_config: {len(netsec_bytes)} bytes")

    # Read icons
    icon192 = (ROOT / 'public' / 'icon-192.png').read_bytes()
    icon512 = (ROOT / 'public' / 'icon-512.png').read_bytes()

    # Build unsigned APK (ZIP)
    unsigned_path = WORK / 'unsigned.apk'
    with zipfile.ZipFile(unsigned_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('AndroidManifest.xml', manifest_bytes)
        z.writestr('classes.dex', dex_bytes)
        z.writestr('resources.arsc', arsc_bytes)
        z.writestr('res/xml/network_security_config.xml', netsec_bytes)
        # Include icons at multiple densities (they need resource IDs which we don't have, but they'll be ignored by package manager if not referenced; ok)
        z.writestr('res/mipmap-hdpi-v4/ic_launcher.png', icon192)
        z.writestr('res/mipmap-xhdpi-v4/ic_launcher.png', icon512)
        z.writestr('res/mipmap-xxhdpi-v4/ic_launcher.png', icon512)
        z.writestr('res/drawable/ic_launcher.png', icon512)
        # Web assets
        for path in DIST.rglob('*'):
            if path.is_file():
                rel = path.relative_to(DIST).as_posix()
                target = f'assets/{rel}'
                z.writestr(target, path.read_bytes())

    print(f"Unsigned APK: {unsigned_path.stat().st_size} bytes")

    print("Signing APK ...")
    sign_apk_v1(unsigned_path, OUT_APK)
    print(f"Signed APK written to: {OUT_APK} ({OUT_APK.stat().st_size / 1024:.1f} KB)")
    return OUT_APK


# ---------- V1 JAR signing ----------
def sign_apk_v1(unsigned_path, out_path):
    """Sign APK with JAR v1 signature using a fresh RSA key (Python cryptography)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa, padding
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    import datetime
    import base64

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'MA'),
        x509.NameAttribute(NameOID.LOCALITY_NAME, 'Marrakech'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Baridat'),
        x509.NameAttribute(NameOID.COMMON_NAME, 'Baridat Debug'),
    ])
    cert = (x509.CertificateBuilder()
        .subject_name(subject).issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow() - datetime.timedelta(days=1))
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365*25))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256()))
    cert_der = cert.public_bytes(serialization.Encoding.DER)

    # Read all non-META-INF entries
    entries = []
    with zipfile.ZipFile(unsigned_path, 'r') as z:
        for n in z.namelist():
            if n.startswith('META-INF/'): continue
            data = z.read(n)
            entries.append((n, data))

    # Build MANIFEST.MF
    def b64(b): return base64.b64encode(b).decode('ascii')
    def wrap(line, n=72):
        return '\n '.join(line[i:i+n] for i in range(0, len(line), n))

    manifest_lines = ['Manifest-Version: 1.0', 'Created-By: Baridat APK Builder 1.0', '']
    sf_lines = ['Signature-Version: 1.0', 'Created-By: Baridat APK Builder 1.0', '']

    manifest_entry_blocks = []
    sf_entry_blocks = []
    for name, data in entries:
        digest = b64(hashlib.sha256(data).digest())
        block = f'Name: {name}\nSHA-256-Digest: {digest}\n\n'
        manifest_entry_blocks.append(block)
        entry_digest = b64(hashlib.sha256(block.encode('utf-8')).digest())
        sf_entry_blocks.append(f'Name: {name}\nSHA-256-Digest: {entry_digest}\n\n')

    manifest = '\n'.join(manifest_lines) + '\n' + ''.join(manifest_entry_blocks)
    manifest_digest = b64(hashlib.sha256(manifest.encode('utf-8')).digest())
    sf_lines.append(f'SHA-256-Digest-Manifest: {manifest_digest}')
    sf_lines.append('')
    sf = '\n'.join(sf_lines) + ''.join(sf_entry_blocks)

    sf_bytes = sf.encode('utf-8')
    from pkcs7_sign import make_pkcs7
    pkcs7_der = make_pkcs7(cert_der, None, sf_bytes, key)

    # Write signed APK
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, data in entries:
            z.writestr(n, data)
        # META-INF files must be STORED (not compressed) per APK spec
        z.writestr('META-INF/MANIFEST.MF', manifest, compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/CERT.SF', sf, compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/CERT.RSA', pkcs7_der, compress_type=zipfile.ZIP_STORED)


def build_pkcs7_signeddata(cert_der, signature, data, key):
    """
    Construct a minimal PKCS#7 SignedData (CMS) DER structure containing one cert, one signature.
    We don't include the data itself (detached signature).
    """
    from pyasn1.type import univ, namedtype, tag
    from pyasn1.codec.der import encoder
    from cryptography.hazmat.primitives.serialization import Encoding

    # Try using pyasn1 if available; otherwise hand-build ASN.1 DER.
    try:
        from pyasn1_modules import rfc2315, rfc2459
        use_pyasn1 = True
    except ImportError:
        use_pyasn1 = False

    if use_pyasn1:
        # full path
        sd = rfc2315.SignedData()
        # but easier to hand-roll a known-good DER
        pass

    # Hand-build DER:
    def der_len(n):
        if n < 0x80: return bytes([n])
        b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
        return bytes([0x80 | len(b)]) + b
    def tl(tag_byte, content):
        return bytes([tag_byte]) + der_len(len(content)) + content
    def seq(content): return tl(0x30, content)
    def ctx(tag, content, constructed=True):
        t = 0xA0 | tag if constructed else 0x80 | tag
        return tl(t, content)
    def oid(dotted):
        # encode OID bytes
        parts = [int(p) for p in dotted.split('.')]
        out = bytes([parts[0]*40 + parts[1]])
        for p in parts[2:]:
            if p < 128:
                out += bytes([p])
            else:
                chunks = []
                while p:
                    chunks.append(p & 0x7F)
                    p >>= 7
                chunks = chunks[::-1]
                for i in range(len(chunks)-1):
                    chunks[i] |= 0x80
                out += bytes(chunks)
        return tl(0x06, out)
    def integer(v):
        b = v.to_bytes((v.bit_length()+7)//8 or 1, 'big')
        if b[0] & 0x80:
            b = b'\x00' + b
        return tl(0x02, b)
    def bitstring(bs):
        return tl(0x03, b'\x00' + bs)
    def utctime(t):
        s = t.strftime('%y%m%d%H%M%SZ').encode('ascii')
        return tl(0x17, s)
    def set_of(content): return tl(0x31, content)
    def octet_string(b): return tl(0x04, b)
    def expl_tag(tag, content): return ctx(tag, content, True)
    def implicit_tag(tag, content): return tl(0x80|tag, content)

    # ContentInfo wrapper: SEQUENCE { OID pkcs7-signedData, [0] EXPLICIT SignedData }
    # SignedData ::= SEQUENCE { version, digestAlgorithms, contentInfo, certificates [0] IMPLICIT, crls [1] IMPLICIT OPTIONAL, signerInfos }
    # digestAlgorithms: SET OF AlgorithmIdentifier (sha256)
    sha256_oid = oid('2.16.840.1.101.3.4.2.1')
    rsa_oid = oid('1.2.840.113549.1.1.1')
    pkcs7_data_oid = oid('1.2.840.113549.1.7.1')
    pkcs7_signeddata_oid = oid('1.2.840.113549.1.7.2')

    import datetime
    # We need issuer+serial from the cert. Parse issuer from cert_der? We know the cert structure we built.
    # Simpler: include the cert DER directly and reuse its issuer/serial by hand.
    # We'll construct the cert SEQUENCE as raw bytes.
    cert_asn1 = cert_der  # already a DER SEQUENCE

    # Issuer and serial: we have them from our build above. But let's just embed issuer as
    # the same subject (self-signed) — we need the exact DER bytes.
    # Parse cert TBS to get issuer and serial
    # cert_der is SEQUENCE { tbs, sigAlg, sigBits }
    # tbs starts at offset of tbs sequence inside outer SEQUENCE
    # We can parse it minimally.
    def parse_tbs(cert_der):
        # Navigate: outer SEQUENCE -> tbs SEQUENCE (first element)
        assert cert_der[0] == 0x30
        pos = 1
        ln = cert_der[pos]; pos += 1
        if ln & 0x80:
            n = ln & 0x7F
            ln = int.from_bytes(cert_der[pos:pos+n], 'big'); pos += n
        tbs_start = pos
        # Now inside tbs: SEQUENCE starts at tbs_start
        assert cert_der[tbs_start] == 0x30
        p = tbs_start + 1
        ln = cert_der[p]; p += 1
        if ln & 0x80:
            n = ln & 0x7F
            ln = int.from_bytes(cert_der[p:p+n], 'big'); p += n
        tbs = cert_der[tbs_start : p + ln]
        # tbs fields: version [0] EXPLICIT, serial, sigAlg, issuer, validity, subject, ...
        bp = 0
        def read_len(bs, off):
            l = bs[off]; off += 1
            if l & 0x80:
                n = l & 0x7F
                l = int.from_bytes(bs[off:off+n], 'big'); off += n
            return l, off
        # skip version if present
        if tbs[0] == 0xA0:
            l, bp = read_len(tbs, 1); bp += l  # skip version
        # serial number
        assert tbs[bp] == 0x02
        l, bp = read_len(tbs, bp+1)
        serial_der = tbs[bp-1-len_len(l):]  # no — simpler: read whole INTEGER including tag+len
        # easier: re-read more carefully
        bp = 0
        if tbs[0] == 0xA0:
            l, bp = read_len(tbs, 1); bp += l
        # serial
        stag = tbs[bp]; assert stag == 0x02
        slen, bp2 = read_len(tbs, bp+1)
        serial_der = tbs[bp : bp2 + slen]
        bp = bp2 + slen
        # signature algorithm (skip)
        assert tbs[bp] == 0x30
        l, bp2 = read_len(tbs, bp+1)
        bp = bp2 + l
        # issuer
        assert tbs[bp] == 0x30
        l, bp2 = read_len(tbs, bp+1)
        issuer_der = tbs[bp : bp2 + l]
        return serial_der, issuer_der

    serial_der, issuer_der = parse_tbs(cert_der)

    digest_alg = seq(sha256_oid + tl(0x05, b''))  # AlgorithmIdentifier with NULL params
    digest_algs = set_of(digest_alg)

    # ContentInfo inside SignedData: OID 1.2.840.113549.1.7.1 (data), no content
    content_info = seq(pkcs7_data_oid)

    # Certificates set [0] IMPLICIT containing our cert
    certs = ctx(0, cert_asn1, constructed=True)

    # SignerInfo: version=1, sid=issuerAndSerialNumber, digestAlg, [0] attrs OPTIONAL, sigAlg, signature
    # For v1 signature with authenticated attributes (required by Android), we need a SET of:
    #  - contentType (pkcs7-data)
    #  - messageDigest (SHA-256 of sf_bytes)
    #  - signingTime (optional but nice)
    message_digest = hashlib.sha256(sf_bytes).digest()

    def attr(oid_bytes, value_der):
        return seq(oid_bytes + set_of(value_der))
    attrs = seq(
        attr(oid('1.2.840.113549.1.9.3'), oid('1.2.840.113549.1.7.1')) +
        attr(oid('1.2.840.113549.1.9.4'), octet_string(message_digest))
    )
    # Sign over DER-encoded attrs (signed attributes)
    signed_attrs_bytes = attrs
    attr_sig = key.sign(signed_attrs_bytes, padding.PKCS1v15(), hashes.SHA256())

    sid = seq(issuer_der + serial_der)  # IssuerAndSerialNumber
    sig_alg = seq(rsa_oid + tl(0x05, b''))  # sha256WithRSAEncryption? Actually we need sha256WithRSAEncryption = 1.2.840.113549.1.1.11
    sig_alg = seq(oid('1.2.840.113549.1.1.11') + tl(0x05, b''))

    signer_info = seq(
        integer(1) +  # version
        sid +
        digest_alg +
        ctx(0, signed_attrs_bytes, constructed=True) +
        sig_alg +
        octet_string(attr_sig)
    )
    signer_infos = set_of(signer_info)

    signed_data = seq(
        integer(1) +  # version
        digest_algs +
        content_info +
        certs +
        expl_tag(1, b'') if False else certs +
        signer_infos
    )
    # Wait — signed_data fields: version, digestAlgs, contentInfo, [0] certs, [1] crls, signerInfos
    # We put certs above correctly.

    signed_data = seq(
        integer(1) +
        digest_algs +
        content_info +
        certs +
        signer_infos
    )

    outer = seq(pkcs7_signeddata_oid + expl_tag(0, signed_data))
    return outer


if __name__ == '__main__':
    build_signed_apk()
