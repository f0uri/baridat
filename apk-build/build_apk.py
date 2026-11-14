#!/usr/bin/env python3
"""
Build a minimal, signed Android APK that wraps a WebView/PWA.
Pure-Python builder — no Java or Android SDK required.

Uses the approach of constructing an APK from pre-compiled template files
that we generate from scratch at the binary level:
- AndroidManifest.xml (binary AXML)
- classes.dex (tiny WebView Activity)
- resources.arsc (minimal)
- res/ files (icons, strings)
- assets/ (web app)
- META-INF/ (signature)
"""

import os, sys, struct, zipfile, hashlib, shutil, io, zlib, time
from pathlib import Path

ROOT = Path('/home/user/baridat')
DIST = ROOT / 'dist'
OUT = ROOT / 'baridat.apk'
BUILD = ROOT / 'apk-build' / 'work'
WORK = BUILD

PKG = 'com.baridat.app'
APP_NAME = 'بريدات'
VERSION_CODE = 4
VERSION_NAME = '1.2.0'

# ---------- Utility: little-endian helpers ----------
def u16(s): return struct.pack('<H', s & 0xFFFF)
def u32(s): return struct.pack('<I', s & 0xFFFFFFFF)

# ---------- AXML (Android Binary XML) encoder ----------
# Minimal AXML generator for AndroidManifest.xml

class AXML:
    """Very small Android Binary XML writer. Just enough for a manifest."""

    # Chunk types
    CHUNK_AXML_FILE = 0x00080003
    CHUNK_STRINGPOOL = 0x001C0001
    CHUNK_RESOURCEIDS = 0x00180180
    CHUNK_START_NS = 0x00100100
    CHUNK_END_NS = 0x00100101
    CHUNK_START_TAG = 0x00100102
    CHUNK_END_TAG = 0x00100103

    # String pool flags
    UTF8_FLAG = 0x100

    def __init__(self):
        self.strings = []
        self.string_map = {}
        self.resource_ids = []
        self.events = []  # (type, data)

    def s(self, val):
        if val not in self.string_map:
            self.string_map[val] = len(self.strings)
            self.strings.append(val)
        return self.string_map[val]

    def attr(self, name, val, ns_idx=0, res_type=0x03):
        """Typed attribute. res_type 0x03 = string (raw), 0x10 = boolean int, 0x0F = reference int."""
        name_idx = self.s(name)
        val_idx = self.s(val) if isinstance(val, str) else -1
        return {
            'ns': ns_idx, 'name': name_idx, 'rawValue': val_idx if val_idx >= 0 else -1,
            'type': res_type, 'data': val_idx if val_idx >= 0 else (val if isinstance(val, int) else 0)
        }

    def start_ns(self, prefix, uri):
        self.events.append(('start_ns', (self.s(prefix), self.s(uri))))
    def end_ns(self, prefix, uri):
        self.events.append(('end_ns', (self.s(prefix), self.s(uri))))
    def start_tag(self, name, ns_idx=0, attrs=None):
        self.events.append(('start_tag', (ns_idx, self.s(name), attrs or [])))
    def end_tag(self, name, ns_idx=0):
        self.events.append(('end_tag', (ns_idx, self.s(name))))

    def build(self):
        # 1. String pool
        # UTF-8
        pool_data = bytearray()
        # offsets
        offsets = []
        # we need to compute string offsets
        str_bytes = bytearray()
        for s in self.strings:
            offsets.append(len(str_bytes))
            enc = s.encode('utf-8')
            # length in UTF-16 code units (approx), then UTF-8 length, then bytes, then NUL
            utflen = len(s.encode('utf-16-le')) // 2
            str_bytes.append(utflen & 0x7F)  # single byte length (assume < 128)
            str_bytes.append(len(enc) & 0x7F)
            str_bytes.extend(enc)
            str_bytes.append(0)
        # pad to 4-byte
        while len(str_bytes) % 4:
            str_bytes.append(0)

        sp_size = 28 + 4*len(self.strings) + len(str_bytes)
        sp_size = (sp_size + 3) & ~3
        pool_data.extend(u32(self.CHUNK_STRINGPOOL))
        pool_data.extend(u32(sp_size))
        pool_data.extend(u32(len(self.strings)))
        pool_data.extend(u32(0))  # style count
        pool_data.extend(u32(self.UTF8_FLAG))
        pool_data.extend(u32(0))  # strings start
        pool_data.extend(u32(0))  # styles start
        # offsets
        strings_start = 28 + 4*len(self.strings)
        for off in offsets:
            pool_data.extend(u32(strings_start + off))
        pool_data.extend(str_bytes)
        while len(pool_data) % 4:
            pool_data.append(0)

        # 2. Resource IDs chunk
        # Map well-known Android attribute names to resource IDs
        ANDROID_ATTRS = {
            'versionCode': 0x0101021b,
            'versionName': 0x0101021c,
            'minSdkVersion': 0x0101020c,
            'targetSdkVersion': 0x01010270,
            'label': 0x01010001,
            'icon': 0x01010002,
            'theme': 0x01010000,
            'name': 0x01010003,
            'value': 0x01010024,
            'configChanges': 0x0101001f,
            'usesCleartextTraffic': 0x01010478,
            'hardwareAccelerated': 0x01010261,
            'allowBackup': 0x01010280,
            'supportsRtl': 0x010103af,
            'exported': 0x010104e3,
            'launchMode': 0x0101001d,
            'screenOrientation': 0x0101001e,
            'networkSecurityConfig': 0x01010545,
        }
        res_ids = []
        for s in self.strings:
            res_ids.append(ANDROID_ATTRS.get(s, 0))
        non_zero = sum(1 for r in res_ids if r != 0)
        # Resource IDs chunk must come right after string pool and must list IDs in string order
        res_data = bytearray()
        res_data.extend(u32(self.CHUNK_RESOURCEIDS))
        res_data.extend(u32(8 + 4*len(res_ids)))
        for r in res_ids:
            res_data.extend(u32(r))
        while len(res_data) % 4:
            res_data.append(0)

        # 3. Events
        ev_data = bytearray()
        def write_start_ns(prefix_idx, uri_idx):
            ev_data.extend(u32(self.CHUNK_START_NS))
            ev_data.extend(u32(0x18))
            ev_data.extend(u32(0))  # line number
            ev_data.extend(u32(-1 & 0xFFFFFFFF))
            ev_data.extend(u32(prefix_idx))
            ev_data.extend(u32(uri_idx))
        def write_end_ns(prefix_idx, uri_idx):
            ev_data.extend(u32(self.CHUNK_END_NS))
            ev_data.extend(u32(0x18))
            ev_data.extend(u32(0))
            ev_data.extend(u32(-1 & 0xFFFFFFFF))
            ev_data.extend(u32(prefix_idx))
            ev_data.extend(u32(uri_idx))

        def write_start_tag(ns_idx, name_idx, attrs):
            attr_start = 0x24
            attr_size = 20
            size = attr_start + attr_size * len(attrs)
            ev_data.extend(u32(self.CHUNK_START_TAG))
            ev_data.extend(u32(size))
            ev_data.extend(u32(0))
            ev_data.extend(u32(-1 & 0xFFFFFFFF))
            ev_data.extend(u32(ns_idx))
            ev_data.extend(u32(name_idx))
            ev_data.extend(u32(0x14))  # attr start offset? (20 = 0x14) — in some encoders
            ev_data.extend(u32(attr_size))
            ev_data.extend(u16(len(attrs)))
            ev_data.extend(u16(0))  # idIndex
            ev_data.extend(u16(0))  # classIndex
            ev_data.extend(u16(0))  # styleIndex
            ev_data.extend(u32(0))  # padding for 0x24 alignment
            for a in attrs:
                ev_data.extend(u32(a['ns']))
                ev_data.extend(u32(a['name']))
                ev_data.extend(u32(a['rawValue']))
                # typed value (8 bytes): size, res0, dataType, data
                sizeBytes = 8
                ev_data.extend(u16(sizeBytes))
                ev_data.extend(u8(0))
                ev_data.extend(u8(a['type']))
                ev_data.extend(u32(a['data']))
        def write_end_tag(ns_idx, name_idx):
            ev_data.extend(u32(self.CHUNK_END_TAG))
            ev_data.extend(u32(0x18))
            ev_data.extend(u32(0))
            ev_data.extend(u32(-1 & 0xFFFFFFFF))
            ev_data.extend(u32(ns_idx))
            ev_data.extend(u32(name_idx))

        for ev in self.events:
            t, d = ev
            if t == 'start_ns': write_start_ns(*d)
            elif t == 'end_ns': write_end_ns(*d)
            elif t == 'start_tag': write_start_tag(*d)
            elif t == 'end_tag': write_end_tag(*d)

        # Combine: file header
        total_size = 8 + len(pool_data) + len(res_data) + len(ev_data)
        out = bytearray()
        out.extend(u32(self.CHUNK_AXML_FILE))
        out.extend(u32(total_size))
        out.extend(pool_data)
        out.extend(res_data)
        out.extend(ev_data)
        return bytes(out)


def u8(s): return struct.pack('<B', s & 0xFF)

# ---------- Build manifest ----------
def build_manifest():
    a = AXML()
    # namespaces
    a.start_ns('android', 'http://schemas.android.com/apk/res/android')
    a.start_ns('app', 'http://schemas.android.com/apk/res-auto')

    NS_ANDROID = a.s('http://schemas.android.com/apk/res/android')

    # <manifest package=... versionCode=... versionName=...>
    attrs = [
        a.attr('package', PKG),
        a.attr('versionCode', VERSION_CODE, ns_idx=NS_ANDROID, res_type=0x10),  # int
        a.attr('versionName', VERSION_NAME, ns_idx=NS_ANDROID),
    ]
    a.start_tag('manifest', attrs=attrs)

    # <uses-sdk minSdkVersion=21 targetSdkVersion=34 />
    a.start_tag('uses-sdk', attrs=[
        a.attr('minSdkVersion', 21, ns_idx=NS_ANDROID, res_type=0x10),
        a.attr('targetSdkVersion', 34, ns_idx=NS_ANDROID, res_type=0x10),
    ])
    a.end_tag('uses-sdk')

    # <uses-permission android:name="android.permission.INTERNET" />
    a.start_tag('uses-permission', attrs=[
        a.attr('name', 'android.permission.INTERNET', ns_idx=NS_ANDROID),
    ])
    a.end_tag('uses-permission')
    a.start_tag('uses-permission', attrs=[
        a.attr('name', 'android.permission.ACCESS_NETWORK_STATE', ns_idx=NS_ANDROID),
    ])
    a.end_tag('uses-permission')

    # <application android:label=... android:icon=... android:theme=... android:usesCleartextTraffic=true ...>
    # 0x7f020000 is our icon resource id — we'll set up in resources.arsc
    app_attrs = [
        a.attr('label', APP_NAME, ns_idx=NS_ANDROID),
        a.attr('icon', 0x7F020000, ns_idx=NS_ANDROID, res_type=0x0F),  # reference
        a.attr('theme', 0x7F030000, ns_idx=NS_ANDROID, res_type=0x0F),  # reference to style
        a.attr('usesCleartextTraffic', 0xFFFFFFFF, ns_idx=NS_ANDROID, res_type=0x12),  # boolean true (0xFFFFFFFF)
        a.attr('hardwareAccelerated', 0xFFFFFFFF, ns_idx=NS_ANDROID, res_type=0x12),
        a.attr('allowBackup', 1, ns_idx=NS_ANDROID, res_type=0x12),
        a.attr('supportsRtl', 0xFFFFFFFF, ns_idx=NS_ANDROID, res_type=0x12),
        a.attr('networkSecurityConfig', 0x7F040000, ns_idx=NS_ANDROID, res_type=0x0F),
    ]
    a.start_tag('application', attrs=app_attrs)

    # <activity android:name=".MainActivity" android:exported=true android:configChanges=... android:launchMode="singleTask">
    act_attrs = [
        a.attr('name', '.MainActivity', ns_idx=NS_ANDROID),
        a.attr('exported', 0xFFFFFFFF, ns_idx=NS_ANDROID, res_type=0x12),
        a.attr('configChanges', 0x000004B0, ns_idx=NS_ANDROID, res_type=0x10),  # orientation|screenSize|keyboardHidden = 0x4B0
        a.attr('launchMode', 1, ns_idx=NS_ANDROID, res_type=0x10),  # singleTask = 1
        a.attr('screenOrientation', -1, ns_idx=NS_ANDROID, res_type=0x10),  # unspecified
    ]
    a.start_tag('activity', attrs=act_attrs)

    a.start_tag('intent-filter')
    a.start_tag('action', attrs=[a.attr('name', 'android.intent.action.MAIN', ns_idx=NS_ANDROID)])
    a.end_tag('action')
    a.start_tag('category', attrs=[a.attr('name', 'android.intent.category.LAUNCHER', ns_idx=NS_ANDROID)])
    a.end_tag('category')
    a.end_tag('intent-filter')

    a.end_tag('activity')
    a.end_tag('application')
    a.end_tag('manifest')
    a.end_ns('app', 'http://schemas.android.com/apk/res-auto')
    a.end_ns('android', 'http://schemas.android.com/apk/res/android')

    return a.build()


# ---------- DEX file generation ----------
# This is the trickiest part. We'll build a minimal DEX with one class (MainActivity)
# that extends Activity and creates a WebView.
# However, writing DEX bytecode manually is complex. Instead, let me use a clever trick:
# the DEX can be embedded as a pre-validated minimal file.
# I'll generate a known-minimal DEX bytecode for a WebView activity.

def build_minimal_dex():
    """
    Build a minimal classes.dex that contains:
      - Lcom/baridat/app/MainActivity; extends Landroid/app/Activity;
      - onCreate: sets a WebView as content view, loads file:///android_asset/index.html,
                  enables JS, DOM storage, wide viewport, sets WebViewClient.

    We build the DEX from binary structures. This is complex but doable.
    Because fully hand-crafting a WebView DEX is error-prone, I'll instead use a
    known pre-assembled DEX blob that's widely used.
    """
    # The safest way in this constrained env is to embed a pre-compiled minimal DEX.
    # We'll construct one from scratch using dexlib principles.
    #
    # For brevity and reliability, I'll use the approach of creating the smallest
    # working DEX that:
    #   - Defines one class (MainActivity)
    #   - Implements onCreate that:
    #       invokes-super onCreate,
    #       new-instance WebView,
    #       invokes getSettings / setJavaScriptEnabled / setDomStorageEnabled / setLoadWithOverviewMode
    #       invokes loadUrl("file:///android_asset/index.html")
    #       invokes setContentView(webView)
    #
    # Let me build this. Since manual DEX is ~2KB, I'll construct it step-by-step.

    from dex_encoder import DexBuilder
    db = DexBuilder()

    # String IDs
    s_init = db.string('<init>')
    s_onCreate = db.string('onCreate')
    s_os = db.string('Landroid/os/Bundle;')
    s_activity = db.string('Landroid/app/Activity;')
    s_main = db.string(f'L{PKG.replace(".","/")}/MainActivity;')
    s_void = db.string('V')
    s_bundle = db.string('Landroid/os/Bundle;')
    s_super = db.string('Landroid/app/Activity;')
    s_webview_cls = db.string('Landroid/webkit/WebView;')
    s_webview = db.string('Landroid/webkit/WebView;')
    s_setContentView = db.string('setContentView')
    s_setContentView_desc = db.string('(Landroid/view/View;)V')
    s_loadUrl = db.string('loadUrl')
    s_loadUrl_desc = db.string('(Ljava/lang/String;)V')
    s_url = db.string('file:///android_asset/index.html')
    s_websettings = db.string('Landroid/webkit/WebSettings;')
    s_getSettings = db.string('getSettings')
    s_getSettings_desc = db.string('()Landroid/webkit/WebSettings;')
    s_setJsEnabled = db.string('setJavaScriptEnabled')
    s_setBool_desc = db.string('(Z)V')
    s_setDom = db.string('setDomStorageEnabled')
    s_setWide = db.string('setUseWideViewPort')
    s_setLoadOverview = db.string('setLoadWithOverviewMode')
    s_setAllowFile = db.string('setAllowFileAccess')
    s_setAllowContent = db.string('setAllowContentAccess')
    s_setMixed = db.string('setMixedContentMode')
    s_webviewclient = db.string('Landroid/webkit/WebViewClient;')
    s_setWVC = db.string('setWebViewClient')
    s_setWVC_desc = db.string('(Landroid/webkit/WebViewClient;)V')
    s_setMediaPlaybackRequiresUserGesture = db.string('setMediaPlaybackRequiresUserGesture')
    s_context = db.string('Landroid/content/Context;')
    s_constructor_desc = db.string('(Landroid/content/Context;)V')

    # Type IDs
    t_void = db.type(s_void)
    t_main = db.type(s_main)
    t_activity = db.type(s_activity)
    t_bundle = db.type(s_bundle)
    t_webview = db.type(s_webview)
    t_websettings = db.type(s_websettings)
    t_webviewclient = db.type(s_webviewclient)
    t_string = db.type('Ljava/lang/String;')
    t_view = db.type('Landroid/view/View;')
    t_context = db.type(s_context)
    t_int = db.type('I')
    t_bool = db.type('Z')

    # Proto IDs
    p_init = db.proto(t_void, [])
    p_onCreate = db.proto(t_void, [t_bundle])
    p_webview_init = db.proto(t_void, [t_context])
    p_setContentView = db.proto(t_void, [t_view])
    p_loadUrl = db.proto(t_void, [t_string])
    p_getSettings = db.proto(t_websettings, [])
    p_setBool = db.proto(t_void, [t_bool])
    p_setInt = db.proto(t_void, [t_int])
    p_setWVC = db.proto(t_void, [t_webviewclient])

    # Field IDs (none needed)

    # Method IDs (we reference Android framework methods; our class has 2 methods: <init>, onCreate)
    m_activity_init = db.method(t_activity, s_init, p_init)
    m_bundle_init = db.method(t_bundle, s_init, p_init)
    m_super_onCreate = db.method(t_activity, s_onCreate, p_onCreate)
    m_webview_init = db.method(t_webview, s_init, p_webview_init)
    m_webview_getSettings = db.method(t_webview, s_getSettings, p_getSettings)
    m_webview_loadUrl = db.method(t_webview, s_loadUrl, p_loadUrl)
    m_webview_setContentView = db.method(t_main, s_setContentView, p_setContentView)  # inherited
    # Actually setContentView is on Activity, not on WebView:
    m_activity_setContentView = db.method(t_activity, s_setContentView, p_setContentView)
    m_settings_setJs = db.method(t_websettings, s_setJsEnabled, p_setBool)
    m_settings_setDom = db.method(t_websettings, s_setDom, p_setBool)
    m_settings_setWide = db.method(t_websettings, s_setWide, p_setBool)
    m_settings_setOverview = db.method(t_websettings, s_setLoadOverview, p_setBool)
    m_settings_setFile = db.method(t_websettings, s_setAllowFile, p_setBool)
    m_settings_setContent = db.method(t_websettings, s_setAllowContent, p_setBool)
    m_settings_setMixed = db.method(t_websettings, s_setMixed, p_setInt)
    m_webview_setWVC = db.method(t_webview, s_setWVC, p_setWVC)
    m_webviewclient_init = db.method(t_webviewclient, s_init, p_init)
    m_settings_setMediaGesture = db.method(t_websettings, s_setMediaPlaybackRequiresUserGesture, p_setBool)

    # Our class methods
    m_our_init = db.method(t_main, s_init, p_init)
    m_our_onCreate = db.method(t_main, s_onCreate, p_onCreate)

    # Class defs
    # access flags: public super (0x0001 | 0x0020) = 0x21
    access = 0x0001 | 0x0020
    cls = db.cls(t_main, access, t_activity, source_file=None)

    # ---- Code for <init> ----
    # public MainActivity() { super(); }
    init_code = [
        ('registers', 2),
        ('ins', 1),
        ('outs', 1),
        ('invoke-direct', {'method': m_activity_init, 'regs': [1], 'proto': p_init, 'is_range': False}),
        ('return-void',),
    ]
    db.add_method(cls, m_our_init, 0x0001 | 0x0002, init_code)

    # ---- Code for onCreate ----
    # v0 = this, v1 = Bundle, v2 = WebView, v3 = WebSettings, v4 = WebViewClient, v5 = const 1, v6 = const 0, v7 = string url
    code = [
        ('registers', 9),
        ('ins', 2),
        ('outs', 3),
        # invoke-super onCreate(v1)
        ('invoke-super', {'method': m_super_onCreate, 'regs': [0, 1], 'proto': p_onCreate, 'is_range': False}),
        # const/4 v5, 1
        ('const', {'reg': 5, 'val': 1}),
        ('const', {'reg': 6, 'val': 0}),
        ('const', {'reg': 8, 'val': 0}),
        # new-instance v2, WebView
        ('new-instance', {'reg': 2, 'type': t_webview}),
        # invoke-direct v2.<init>(v0)
        ('invoke-direct', {'method': m_webview_init, 'regs': [2, 0], 'proto': p_webview_init, 'is_range': False}),
        # invoke-virtual v2.getSettings() -> v3
        ('invoke-virtual', {'method': m_webview_getSettings, 'regs': [2], 'proto': p_getSettings, 'is_range': False}),
        ('move-result-object', {'reg': 3}),
        # v3.setJavaScriptEnabled(true)
        ('invoke-virtual', {'method': m_settings_setJs, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setDomStorageEnabled(true)
        ('invoke-virtual', {'method': m_settings_setDom, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setUseWideViewPort(true)
        ('invoke-virtual', {'method': m_settings_setWide, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setLoadWithOverviewMode(true)
        ('invoke-virtual', {'method': m_settings_setOverview, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setAllowFileAccess(true)
        ('invoke-virtual', {'method': m_settings_setFile, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setAllowContentAccess(true)
        ('invoke-virtual', {'method': m_settings_setContent, 'regs': [3, 5], 'proto': p_setBool, 'is_range': False}),
        # v3.setMediaPlaybackRequiresUserGesture(false)
        ('invoke-virtual', {'method': m_settings_setMediaGesture, 'regs': [3, 6], 'proto': p_setBool, 'is_range': False}),
        # v3.setMixedContentMode(0) = MIXED_CONTENT_ALWAYS_ALLOW
        ('invoke-virtual', {'method': m_settings_setMixed, 'regs': [3, 8], 'proto': p_setInt, 'is_range': False}),
        # new-instance v4, WebViewClient; invoke-direct
        ('new-instance', {'reg': 4, 'type': t_webviewclient}),
        ('invoke-direct', {'method': m_webviewclient_init, 'regs': [4], 'proto': p_init, 'is_range': False}),
        # v2.setWebViewClient(v4)
        ('invoke-virtual', {'method': m_webview_setWVC, 'regs': [2, 4], 'proto': p_setWVC, 'is_range': False}),
        # const-string v7, url
        ('const-string', {'reg': 7, 'string': s_url}),
        # v2.loadUrl(v7)
        ('invoke-virtual', {'method': m_webview_loadUrl, 'regs': [2, 7], 'proto': p_loadUrl, 'is_range': False}),
        # setContentView(v2)
        ('invoke-virtual', {'method': m_activity_setContentView, 'regs': [0, 2], 'proto': p_setContentView, 'is_range': False}),
        ('return-void',),
    ]
    db.add_method(cls, m_our_onCreate, 0x0001 | 0x0004, code)  # public

    return db.build()


# ---------- Signature (v1 JAR signing) ----------
def sign_apk(apk_path, out_path, keystore_path=None):
    """Sign the APK with a debug key using only Python stdlib (RSA+SHA256)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.hazmat.primitives.asymmetric import utils
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    import datetime
    import base64

    # Generate key if needed
    if keystore_path and os.path.exists(keystore_path):
        with open(keystore_path, 'rb') as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
        # Load cert
        cert_path = keystore_path.replace('.pem', '.crt')
        if os.path.exists(cert_path):
            with open(cert_path, 'rb') as f:
                cert = x509.load_pem_x509_certificate(f.read())
        else:
            cert = None
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COUNTRY_NAME, 'MA'),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Baridat'),
            x509.NameAttribute(NameOID.COMMON_NAME, 'Baridat Debug'),
        ])
        cert = x509.CertificateBuilder().subject_name(subject).issuer_name(issuer) \
            .public_key(key.public_key()).serial_number(x509.random_serial_number()) \
            .not_valid_before(datetime.datetime.utcnow() - datetime.timedelta(days=1)) \
            .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365*25)) \
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True) \
            .sign(key, hashes.SHA256())

    # Read zip, compute signatures for each non-META-INF file
    with zipfile.ZipFile(apk_path, 'r') as z:
        names = [n for n in z.namelist() if not n.startswith('META-INF/')]
        # Build manifest
        manifest = 'Manifest-Version: 1.0\nCreated-By: Baridat Builder\n\n'
        sig_lines = ''
        for n in names:
            data = z.read(n)
            digest = base64.b64encode(hashlib.sha256(data).digest()).decode('ascii')
            # 72-char line wrapping for name
            wrapped_name = '\n '.join([n[i:i+70] for i in range(0, len(n), 70)])
            manifest += f'Name: {wrapped_name}\nSHA-256-Digest: {digest}\n\n'
            # For SF, hash the manifest entry too
            entry = f'Name: {n}\nSHA-256-Digest: {digest}\n\n'
            entry_digest = base64.b64encode(hashlib.sha256(entry.encode('utf-8')).digest()).decode('ascii')
            sig_lines += f'Name: {wrapped_name}\nSHA-256-Digest: {entry_digest}\n\n'

        manifest_digest = base64.b64encode(hashlib.sha256(manifest.encode('utf-8')).digest()).decode('ascii')
        sf = f'Signature-Version: 1.0\nCreated-By: Baridat Builder\nSHA-256-Digest-Manifest: {manifest_digest}\n\n{sig_lines}'
        sf_bytes = sf.encode('utf-8')

        # Sign SF with RSA
        sig = key.sign(sf_bytes, padding.PKCS1v15(), hashes.SHA256())

        # Build PKCS#7 detached signature (simplified, we use raw RSA + cert in DER wrapped in PKCS#7)
        # For APK v1 signing, we need a valid PKCS#7 SignedData structure.
        # This is complex — let's use the asn1crypto/cryptography approach.
        from pkcs7_sign import make_pkcs7
        pkcs7_der = make_pkcs7(cert, sig, sf_bytes, key)

        # Write the output zip with signatures
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zo:
            for n in names:
                zo.writestr(n, z.read(n))
            zo.writestr('META-INF/MANIFEST.MF', manifest)
            zo.writestr('META-INF/CERT.SF', sf)
            zo.writestr('META-INF/CERT.RSA', pkcs7_der)

    return out_path


if __name__ == '__main__':
    print("Starting APK build...")
    print("This script requires dex_encoder.py and pkcs7_sign.py")
