"""
Minimal resources.arsc builder.
Enough to provide:
  - app_name string
  - mipmap icon (reference to PNG)
  - theme resource
  - network security config resource (xml)
"""
import struct
from collections import OrderedDict

def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)

class ResTable:
    # Type constants for chunks
    RES_TABLE_TYPE = 0x00020000
    RES_STRING_POOL_TYPE = 0x001C0001
    RES_TABLE_PACKAGE_TYPE = 0x00020000
    RES_TABLE_TYPE_TYPE = 0x02020000  # actually: RES_TABLE_TYPE_SPEC_TYPE=0x0202, RES_TABLE_TYPE_TYPE=0x0201
    # Correct:
    RES_TABLE_PACKAGE = 0x0200
    RES_TABLE_TYPE_SPEC = 0x0202
    RES_TABLE_TYPE = 0x0201
    RES_TABLE_LIBRARY_TYPE = 0x0203

    UTF8_FLAG = 0x100

    def __init__(self, package_id=0x7F, package_name='com.baridat.app'):
        self.package_id = package_id
        self.package_name = package_name
        # global string pool (values)
        self.global_strings = []
        self.global_smap = {}
        # package -> type name string pool and key string pool
        self.type_names = []   # e.g. ['mipmap', 'string', 'style', 'xml']
        self.type_names_map = {}
        self.key_strings = []
        self.key_smap = {}
        # type entries: { type_name: [ {key: value_info, ...}, ... ] }
        self.types = OrderedDict()
        # Configs (only default config)
        self.default_config = bytes([0]*64)  # 64-byte ResTable_config

    def gstr(self, s):
        if s not in self.global_smap:
            self.global_smap[s] = len(self.global_strings)
            self.global_strings.append(s)
        return self.global_smap[s]

    def key(self, s):
        if s not in self.key_smap:
            self.key_smap[s] = len(self.key_strings)
            self.key_strings.append(s)
        return self.key_smap[s]

    def type_idx(self, name):
        if name not in self.type_names_map:
            self.type_names_map[name] = len(self.type_names)
            self.type_names.append(name)
            self.types[name] = []  # list of entries per config
        return self.type_names_map[name]

    def add_entry(self, res_type, name, value_bytes):
        """Add an entry under given res_type (e.g. 'string', 'mipmap') with given name.
        value_bytes is the Res_value struct (8 bytes) or raw data for complex entries."""
        t_idx = self.type_idx(res_type)
        self.key(name)  # ensure name is in key string pool
        if not self.types[res_type]:
            self.types[res_type].append({})  # one config
        self.types[res_type][0][name] = value_bytes

    def _build_string_pool(self, strings, is_utf8=True):
        HEADER = 28
        offsets = []
        body = bytearray()
        for s in strings:
            offsets.append(len(body))
            if is_utf8:
                enc = s.encode('utf-8') if isinstance(s, bytes) is False else s
                if isinstance(s, str):
                    enc = s.encode('utf-8')
                else:
                    enc = s
                utflen = len(s.encode('utf-16-le')) // 2 if isinstance(s, str) else len(enc)
                body.append(utflen & 0x7F)
                body.append(len(enc) & 0x7F)
                body.extend(enc)
                body.append(0)
            else:
                enc = s.encode('utf-16-le') if isinstance(s, str) else s
                body.append(len(s) & 0xFF)
                body.extend(enc)
                body.append(0); body.append(0)
        while len(body) % 4: body.append(0)
        off_start = HEADER + 4 * len(strings)
        size = off_start + len(body)
        out = bytearray()
        out += u32(self.RES_STRING_POOL_TYPE)
        out += u32(size)
        out += u32(len(strings))
        out += u32(0)
        out += u32(self.UTF8_FLAG if is_utf8 else 0)
        out += u32(off_start)
        out += u32(0)
        for o in offsets:
            out += u32(o)
        out += body
        return bytes(out)

    def _build_package(self):
        """Build ResTable_package."""
        # Package header:
        # struct ResTable_package {
        #   struct ResChunk_header header;
        #   uint32_t id;
        #   uint16_t name[128];  // package name in UTF-16
        #   uint32_t typeStrings;
        #   uint32_t lastPublicType;
        #   uint32_t keyStrings;
        #   uint32_t lastPublicKey;
        #   uint32_t typeIdOffset;
        # }
        # typeStrings offset points to ResStringPool for type names, starting after package header (0x120 = 288 bytes)
        PKHDR_SIZE = 0x120

        # Build type string pool
        # Type names are stored as raw strings (no prefix 'mipmap', etc.)
        type_pool = self._build_string_pool(self.type_names, is_utf8=False)
        key_pool = self._build_string_pool(self.key_strings, is_utf8=False)

        type_strings_off = PKHDR_SIZE
        key_strings_off = type_strings_off + len(type_pool)

        # After key pool, we have type spec + type chunks.
        after_pools = key_strings_off + len(key_pool)

        # Build type spec + type chunks
        chunks = bytearray()
        type_index_list = []
        for t_idx, tname in enumerate(self.type_names):
            entries_list = self.types[tname]
            n_entries = max(len(e) for e in entries_list)
            # Build type spec (1 type with n entries)
            # ResTable_typeSpec
            spec_size = 16 + 4 * n_entries
            chunks += u32(0x0202)
            chunks += u32(spec_size)
            chunks += u8(t_idx + 1)  # id (1-based)
            chunks += u8(0); chunks += u16(0)  # res0, res1
            chunks += u32(n_entries)
            # entry flags (0 for all)
            for _ in range(n_entries):
                chunks += u32(0)

            # Build one ResTable_type per config (just default config)
            # Need to order entries by key index, and record offsets.
            type_entries = entries_list[0]
            # Sort entries by key index
            sorted_keys = sorted(type_entries.keys(), key=lambda k: self.key_smap[k])
            n = len(sorted_keys)
            # Entry table: offsets array (u32 each, 0xFFFFFFFF for no entry)
            # Build entries + values
            entry_start = 0x54 + 4 * n  # offset of entries array start (from chunk start)
            entries_data = bytearray()
            offsets_arr = []
            for k in sorted_keys:
                v = type_entries[k]
                off = entry_start + len(entries_data)
                offsets_arr.append(off)
                # ResTable_entry: size(u16) flags(u16) key(index(u32))
                entries_data += u16(8)
                entries_data += u16(0)
                entries_data += u32(self.key_smap[k])
                # Res_value: size(8), res0(0), dataType, data
                if isinstance(v, dict):
                    # complex (like map for style)
                    # Flag = 1 (complex)
                    entries_data[-4:-2] = u16(0x01)  # set FLAG_COMPLEX
                    # ResTable_map entries
                    # parent ref (u32) + count (u32) + entries
                    entries_data[-2:] = b''  # back off
                    # We'll rebuild properly below
                    pass
                entries_data += v

            # Pad entries to 4-byte boundary
            while len(entries_data) % 4: entries_data.append(0)
            # Build type chunk
            type_size = 0x54 + 4*n + len(entries_data)  # header + offsets + entries
            chunks += u32(0x0201)
            chunks += u32(type_size)
            chunks += u8(t_idx + 1)  # type id
            chunks += u8(0); chunks += u8(0); chunks += u8(0)  # flags, res0, res1
            chunks += u32(0)  # entry count? no: reserved
            chunks += u32(n)  # entry count
            chunks += u32(entry_start)  # entriesStart
            chunks += self.default_config  # 64-byte ResTable_config
            for off in offsets_arr:
                chunks += u32(off)
            chunks += entries_data
            # align
            while len(chunks) % 4: chunks.append(0)

        # Build package chunk
        pkg_size = PKHDR_SIZE + len(type_pool) + len(key_pool) + len(chunks)
        out = bytearray()
        out += u32(self.RES_TABLE_PACKAGE)
        out += u32(pkg_size)
        out += u32(self.package_id)
        # Package name as UTF-16 zero-padded to 128 u16s
        name_utf16 = self.package_name.encode('utf-16-le')
        name_utf16 = name_utf16[:256]
        name_utf16 = name_utf16 + b'\x00' * (256 - len(name_utf16))
        out += name_utf16
        out += u32(type_strings_off)
        out += u32(len(self.type_names) - 1)  # lastPublicType
        out += u32(key_strings_off)
        out += u32(len(self.key_strings) - 1)  # lastPublicKey
        out += u32(0)  # typeIdOffset
        out += b'\x00' * (PKHDR_SIZE - 28 - 4 - 256 - 4*6)  # pad to PKHDR_SIZE
        assert len(out) == PKHDR_SIZE
        out += type_pool
        out += key_pool
        out += chunks
        return bytes(out)

    def build(self):
        # Global string pool
        global_pool = self._build_string_pool(self.global_strings, is_utf8=True)
        pkg_bytes = self._build_package()
        total_size = 12 + len(global_pool) + len(pkg_bytes)
        out = bytearray()
        # ResTable_header
        out += u32(self.RES_TABLE_TYPE)
        out += u32(total_size)
        out += u32(1)  # package count
        out += global_pool
        out += pkg_bytes
        return bytes(out)


def res_value(dtype, data):
    """Build an 8-byte Res_value struct."""
    return u16(8) + u8(0) + u8(dtype) + u32(data)

# Data types
TYPE_NULL = 0x00
TYPE_REFERENCE = 0x01
TYPE_ATTRIBUTE = 0x02
TYPE_STRING = 0x03
TYPE_FLOAT = 0x04
TYPE_DIMENSION = 0x05
TYPE_FRACTION = 0x06
TYPE_INT_DEC = 0x10
TYPE_INT_BOOLEAN = 0x12
TYPE_INT_COLOR_ARGB8 = 0x1C
