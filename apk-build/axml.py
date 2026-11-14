"""
Minimal Android Binary XML (AXML) encoder.
Supports what we need for AndroidManifest.xml.
"""
import struct

def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)

class Pool:
    UTF8 = 0x100
    def __init__(self):
        self.slist = []
        self.smap = {}
    def add(self, s):
        if s not in self.smap:
            self.smap[s] = len(self.slist)
            self.slist.append(s)
        return self.smap[s]
    def get(self, s):
        return self.smap.get(s, -1)
    def build(self):
        # String pool starts with header, then offsets, then string bytes
        HEADER = 28
        offsets = []
        body = bytearray()
        for s in self.slist:
            offsets.append(len(body))
            # UTF-8 encoding: two length bytes (utf16len, utf8len), then bytes, then NUL
            enc = s.encode('utf-8')
            utflen = len(s.encode('utf-16-le')) // 2
            # encode lengths as uleb128 (single byte for lengths < 128)
            body.append(utflen & 0x7F)
            body.append(len(enc) & 0x7F)
            body.extend(enc)
            body.append(0)  # null terminator
        while len(body) % 4: body.append(0)
        off_start = HEADER + 4 * len(self.slist)
        out = bytearray()
        out += u32(0x001C0001)  # chunk type
        out += u32(HEADER + 4*len(self.slist) + len(body))
        out += u32(len(self.slist))
        out += u32(0)  # styles
        out += u32(self.UTF8)
        out += u32(off_start - 28 + 28)  # strings start (offset from chunk start to strings data)
        out += u32(0)  # styles start
        for o in offsets:
            out += u32(off_start + o)
        out += body
        return bytes(out)


class AXML:
    CHUNK_AXML = 0x00080003
    CHUNK_RESIDS = 0x00180180
    CHUNK_START_NS = 0x00100100
    CHUNK_END_NS = 0x00100101
    CHUNK_START_TAG = 0x00100102
    CHUNK_END_TAG = 0x00100103

    # Known Android attribute resource IDs
    ANDROID_ATTRS = {
        'theme': 0x01010000,
        'label': 0x01010001,
        'icon': 0x01010002,
        'name': 0x01010003,
        'value': 0x01010024,
        'configChanges': 0x0101001f,
        'launchMode': 0x0101001d,
        'screenOrientation': 0x0101001e,
        'minSdkVersion': 0x0101020c,
        'targetSdkVersion': 0x01010270,
        'versionCode': 0x0101021b,
        'versionName': 0x0101021c,
        'hardwareAccelerated': 0x01010261,
        'allowBackup': 0x01010280,
        'usesCleartextTraffic': 0x01010478,
        'exported': 0x010104e3,
        'networkSecurityConfig': 0x01010545,
        'supportsRtl': 0x010103af,
    }

    def __init__(self):
        self.pool = Pool()
        self.events = []

    def add_ns(self, prefix, uri):
        self.pool.add(prefix); self.pool.add(uri)
        return (self.pool.get(prefix), self.pool.get(uri))

    def start_ns(self, prefix, uri):
        self.events.append(('start_ns', self.add_ns(prefix, uri)))
    def end_ns(self, prefix, uri):
        self.events.append(('end_ns', self.add_ns(prefix, uri)))

    def _attr(self, name, value, ns_uri=None, dtype=0x03):
        """dtype: 0x03=string, 0x0F=reference, 0x10=int, 0x12=bool int."""
        name_idx = self.pool.add(name)
        if ns_uri:
            ns_idx = self.pool.add(ns_uri)
        else:
            ns_idx = -1
        if dtype == 0x03:  # string
            val_idx = self.pool.add(str(value))
            data = val_idx
        else:
            val_idx = -1
            data = int(value)
        return {'ns': ns_idx, 'name': name_idx, 'raw': val_idx, 'type': dtype, 'data': data}

    def start_tag(self, name, attrs=None, ns_uri=None):
        ns_idx = self.pool.add(ns_uri) if ns_uri else -1
        name_idx = self.pool.add(name)
        self.events.append(('start_tag', (ns_idx, name_idx, attrs or [])))

    def end_tag(self, name, ns_uri=None):
        ns_idx = self.pool.add(ns_uri) if ns_uri else -1
        name_idx = self.pool.add(name)
        self.events.append(('end_tag', (ns_idx, name_idx)))

    def a(self, name, value, dtype=0x03):
        return self._attr(name, value, 'http://schemas.android.com/apk/res/android', dtype)

    def build(self):
        pool_bytes = self.pool.build()
        # Build resource IDs in string order
        res_ids = bytearray()
        for s in self.pool.slist:
            rid = self.ANDROID_ATTRS.get(s, 0)
            res_ids += u32(rid)
        res_chunk = bytearray()
        if res_ids:
            res_chunk += u32(self.CHUNK_RESIDS)
            res_chunk += u32(8 + len(res_ids))
            res_chunk += res_ids
            while len(res_chunk) % 4: res_chunk.append(0)

        # Build events
        ev = bytearray()
        for typ, d in self.events:
            if typ == 'start_ns':
                p, u = d
                ev += u32(self.CHUNK_START_NS)
                ev += u32(0x18)
                ev += u32(0); ev += u32(-1 & 0xFFFFFFFF)
                ev += u32(p); ev += u32(u)
            elif typ == 'end_ns':
                p, u = d
                ev += u32(self.CHUNK_END_NS)
                ev += u32(0x18)
                ev += u32(0); ev += u32(-1 & 0xFFFFFFFF)
                ev += u32(p); ev += u32(u)
            elif typ == 'start_tag':
                ns_idx, name_idx, attrs = d
                ATTR_SIZE = 20
                ATTR_START = 0x24
                size = ATTR_START + ATTR_SIZE * len(attrs)
                ev += u32(self.CHUNK_START_TAG)
                ev += u32(size)
                ev += u32(0); ev += u32(-1 & 0xFFFFFFFF)
                ev += u32(ns_idx); ev += u32(name_idx)
                ev += u32(0x14)  # attributeStart=0x14?
                ev += u16(ATTR_SIZE); ev += u16(len(attrs))
                ev += u16(0); ev += u16(0); ev += u16(0)  # id/class/style indices
                ev += u32(0)  # pad to 0x24
                for a in attrs:
                    ev += u32(a['ns'])
                    ev += u32(a['name'])
                    ev += u32(a['raw'])
                    ev += u16(8); ev += u8(0); ev += u8(a['type'])
                    ev += u32(a['data'])
            elif typ == 'end_tag':
                ns_idx, name_idx = d
                ev += u32(self.CHUNK_END_TAG)
                ev += u32(0x18)
                ev += u32(0); ev += u32(-1 & 0xFFFFFFFF)
                ev += u32(ns_idx); ev += u32(name_idx)

        total = 8 + len(pool_bytes) + len(res_chunk) + len(ev)
        out = bytearray()
        out += u32(self.CHUNK_AXML); out += u32(total)
        out += pool_bytes
        out += res_chunk
        out += ev
        return bytes(out)


def build_manifest(pkg, app_name, version_code, version_name, icon_ref, theme_ref, netsec_ref):
    x = AXML()
    NS = 'http://schemas.android.com/apk/res/android'
    x.start_ns('android', NS)
    x.start_tag('manifest', [
        x._attr('package', pkg),
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
        x.a('label', app_name),
        x._attr('icon', icon_ref, NS, dtype=0x0F),
        x._attr('theme', theme_ref, NS, dtype=0x0F),
        x.a('usesCleartextTraffic', 0xFFFFFFFF, dtype=0x12),
        x.a('hardwareAccelerated', 0xFFFFFFFF, dtype=0x12),
        x.a('allowBackup', 1, dtype=0x12),
        x.a('supportsRtl', 0xFFFFFFFF, dtype=0x12),
        x._attr('networkSecurityConfig', netsec_ref, NS, dtype=0x0F),
    ])

    x.start_tag('activity', [
        x.a('name', '.MainActivity'),
        x.a('exported', 0xFFFFFFFF, dtype=0x12),
        x.a('configChanges', 0x04B0, dtype=0x10),
        x.a('launchMode', 1, dtype=0x10),
        x.a('screenOrientation', 0xFFFFFFFF, dtype=0x10),
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
