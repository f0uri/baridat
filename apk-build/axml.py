"""
Minimal Android Binary XML (AXML) encoder for AndroidManifest.xml.

Every chunk starts with ResChunk_header (8 bytes):
  uint16 type;
  uint16 headerSize;
  uint32 size;
"""
import struct

def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)


def chunk(type_id, header_size, body_bytes):
    """Build a chunk: type(u16) headerSize(u16) size(u32) + [header fields beyond first 8] + body.

    The caller must pass ALL bytes after the 8-byte ResChunk_header as body_bytes,
    i.e. body_bytes includes (headerSize - 8) bytes of fixed header fields, followed by
    the variable-length body.
    Total chunk size = 8 + len(body_bytes)
    """
    total_size = 8 + len(body_bytes)
    return u16(type_id) + u16(header_size) + u32(total_size) + body_bytes


# Chunk types
RES_STRING_POOL_TYPE = 0x0001
RES_XML_TYPE = 0x0003
RES_XML_START_NS = 0x0100
RES_XML_END_NS = 0x0101
RES_XML_START_ELEMENT = 0x0102
RES_XML_END_ELEMENT = 0x0103
RES_XML_RESOURCE_MAP = 0x0180


class AXML:
    ANDROID_ATTRS = {
        'theme': 0x01010000, 'label': 0x01010001, 'icon': 0x01010002,
        'name': 0x01010003, 'configChanges': 0x0101001f,
        'launchMode': 0x0101001d, 'screenOrientation': 0x0101001e,
        'minSdkVersion': 0x0101020c, 'targetSdkVersion': 0x01010270,
        'versionCode': 0x0101021b, 'versionName': 0x0101021c,
        'hardwareAccelerated': 0x01010261, 'allowBackup': 0x01010280,
        'usesCleartextTraffic': 0x01010478, 'exported': 0x010104e3,
        'networkSecurityConfig': 0x01010545, 'supportsRtl': 0x010103af,
    }

    def __init__(self):
        self.pool = []
        self.pmap = {}
        self.events = []

    def s(self, v):
        if v not in self.pmap:
            self.pmap[v] = len(self.pool)
            self.pool.append(v)
        return self.pmap[v]

    def start_ns(self, prefix, uri):
        self.events.append(('start_ns', self.s(prefix), self.s(uri)))
    def end_ns(self, prefix, uri):
        self.events.append(('end_ns', self.s(prefix), self.s(uri)))

    def attr(self, name, val, ns_uri=None, dtype=0x03, raw=None):
        ni = self.s(name)
        nsi = self.s(ns_uri) if ns_uri else 0xFFFFFFFF
        if dtype == 0x03 and isinstance(val, str):
            vi = self.s(val); data = vi
        else:
            vi = raw if raw is not None else 0xFFFFFFFF
            data = val if isinstance(val, int) else (raw if raw is not None else 0)
        return (nsi, ni, vi, dtype, data)

    def a(self, name, val, dtype=0x03):
        return self.attr(name, val, 'http://schemas.android.com/apk/res/android', dtype)

    def start_tag(self, name, attrs=None):
        self.events.append(('start_tag', self.s(name), attrs or []))
    def end_tag(self, name):
        self.events.append(('end_tag', self.s(name)))

    def _build_string_pool(self):
        HEADER = 28
        UTF8 = 0x100
        offsets = []
        body = bytearray()
        for s in self.pool:
            offsets.append(len(body))
            enc = s.encode('utf-8')
            utflen = len(s.encode('utf-16-le')) // 2
            body.append(utflen & 0x7F)
            body.append(len(enc) & 0x7F)
            body.extend(enc)
            body.append(0)
        while len(body) % 4: body.append(0)
        strings_start = HEADER + 4 * len(self.pool)  # offset relative to chunk start
        fixed = bytearray()
        fixed += u32(len(self.pool))
        fixed += u32(0)  # styles
        fixed += u32(UTF8)
        fixed += u32(strings_start)
        fixed += u32(0)  # styles start
        for o in offsets:
            fixed += u32(o)
        fixed += body
        return chunk(RES_STRING_POOL_TYPE, HEADER, bytes(fixed))

    def _build_resource_map(self):
        # headerSize = 8
        resids = [self.ANDROID_ATTRS.get(s, 0) for s in self.pool]
        body = b''.join(u32(r) for r in resids)
        return chunk(RES_XML_RESOURCE_MAP, 8, body)

    def _build_events(self):
        out = bytearray()
        for ev in self.events:
            t = ev[0]
            if t == 'start_ns':
                _, pi, ui = ev
                # ResXmlNamespaceStart: prefix(4), uri(4) after line+comment (8)
                body = u32(0) + u32(-1 & 0xFFFFFFFF) + u32(pi) + u32(ui)
                out += chunk(RES_XML_START_NS, 0x10, body)
            elif t == 'end_ns':
                _, pi, ui = ev
                body = u32(0) + u32(-1 & 0xFFFFFFFF) + u32(pi) + u32(ui)
                out += chunk(RES_XML_END_NS, 0x10, body)
            elif t == 'start_tag':
                _, ni, attrs = ev
                n = len(attrs)
                # AOSP: headerSize is the ResXMLTree_node header only (16 bytes:
                # chunk header 8 + lineNumber 4 + comment 4). The attrExt
                # (ns/name/attrStart/...) is body, NOT header. A larger
                # headerSize makes the parser read the first attribute as the
                # element itself ("package" instead of "manifest") and the
                # install fails with "problem parsing the package".
                HEADER = 0x10
                body = bytearray()
                body += u32(0)  # line no
                body += u32(-1 & 0xFFFFFFFF)  # comment (-1)
                body += u32(0xFFFFFFFF)  # ns (-1 = none)
                body += u32(ni)
                body += u16(0x14)  # attributeStart (offset 20 from start of element = 20 bytes in: after ns+name)
                body += u16(20)   # attributeSize
                body += u16(n)
                body += u16(0); body += u16(0); body += u16(0)
                for (nsi, a_i, vi, dtype, data) in attrs:
                    body += u32(nsi)
                    body += u32(a_i)
                    body += u32(vi)
                    body += u16(8); body += u8(0); body += u8(dtype)
                    body += u32(data)
                while len(body) % 4: body.append(0)
                out += chunk(RES_XML_START_ELEMENT, HEADER, bytes(body))
            elif t == 'end_tag':
                _, ni = ev
                # Same as start_tag: headerSize is the node header only (16).
                HEADER = 0x10
                body = u32(0) + u32(-1 & 0xFFFFFFFF) + u32(0xFFFFFFFF) + u32(ni)
                out += chunk(RES_XML_END_ELEMENT, HEADER, body)
        return bytes(out)

    def build(self):
        sp = self._build_string_pool()
        rm = self._build_resource_map()
        ev = self._build_events()
        # ResXmlTree_start headerSize = 8 (no extra fields)
        return chunk(RES_XML_TYPE, 8, b'' + sp + rm + ev)


def build_manifest(pkg, app_name_label_res, version_code, version_name,
                   icon_ref, theme_ref):
    x = AXML()
    NS = 'http://schemas.android.com/apk/res/android'
    x.start_ns('android', NS)
    x.start_tag('manifest', [
        x.attr('package', pkg),
        x.a('versionCode', version_code, dtype=0x10),
        x.a('versionName', version_name, dtype=0x03),
    ])
    x.start_tag('uses-sdk', [
        x.a('minSdkVersion', 21, dtype=0x10),
        x.a('targetSdkVersion', 34, dtype=0x10),
    ])
    x.end_tag('uses-sdk')
    x.start_tag('uses-permission', [x.a('name', 'android.permission.INTERNET')])
    x.end_tag('uses-permission')
    x.start_tag('uses-permission', [x.a('name', 'android.permission.ACCESS_NETWORK_STATE')])
    x.end_tag('uses-permission')

    x.start_tag('application', [
        x.attr('label', None, NS, dtype=0x01, raw=app_name_label_res),
        x.attr('icon', None, NS, dtype=0x01, raw=icon_ref),
        x.attr('theme', None, NS, dtype=0x01, raw=theme_ref),
        x.a('usesCleartextTraffic', 0xFFFFFFFF, dtype=0x12),
        x.a('hardwareAccelerated', 0xFFFFFFFF, dtype=0x12),
        x.a('allowBackup', 0xFFFFFFFF, dtype=0x12),  # canonical boolean true
        x.a('supportsRtl', 0xFFFFFFFF, dtype=0x12),
        # NOTE: no networkSecurityConfig attribute — the resource 0x7F040000
        # it used to point at was never registered in resources.arsc, so the
        # manifest referenced a resource that does not exist (dangling
        # reference). The app allows cleartext via usesCleartextTraffic above.
    ])

    x.start_tag('activity', [
        x.a('name', '.MainActivity'),
        x.a('exported', 0xFFFFFFFF, dtype=0x12),
        x.a('configChanges', 0x04B0, dtype=0x10),
        x.a('launchMode', 1, dtype=0x10),
    ])
    x.start_tag('intent-filter')
    x.start_tag('action', [x.a('name', 'android.intent.action.MAIN')])
    x.end_tag('action')
    x.start_tag('category', [x.a('name', 'android.intent.category.LAUNCHER')])
    x.end_tag('category')
    x.end_tag('intent-filter')
    x.end_tag('activity')
    x.end_tag('application')
    x.end_tag('manifest')
    x.end_ns('android', NS)
    return x.build()
