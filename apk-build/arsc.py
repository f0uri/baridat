"""
Minimal resources.arsc builder.
Produces a resources.arsc that defines one string resource ("app_name").

Android binary resource chunks start with ResChunk_header:
  uint16 type;
  uint16 headerSize;
  uint32 size;
"""
import struct
from collections import OrderedDict

def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)

# Chunk types
RES_NULL_TYPE = 0x0000
RES_STRING_POOL_TYPE = 0x0001
RES_TABLE_TYPE = 0x0002
RES_TABLE_PACKAGE_TYPE = 0x0200
RES_TABLE_TYPE_SPEC_TYPE = 0x0202
RES_TABLE_TYPE_TYPE = 0x0201

UTF8_FLAG = 0x100

def chunk_header(chunk_type, header_size, body_after_header):
    """Build a chunk where body_after_header is all bytes after the 8-byte ResChunk_header.
    header_size: size of the fixed header (including 8-byte ResChunk_header).
    body_after_header: everything after the first 8 bytes (fixed header fields + variable body).
    Total chunk size = 8 + len(body_after_header).
    """
    total = 8 + len(body_after_header)
    return u16(chunk_type) + u16(header_size) + u32(total) + body_after_header


class ResTable:
    def __init__(self, package_id=0x7F, package_name='com.baridat.app'):
        self.package_id = package_id
        self.package_name = package_name
        self.global_strings = []
        self.global_smap = {}
        self.type_names = []
        self.type_names_map = {}
        self.key_strings = []
        self.key_smap = {}
        self.types = OrderedDict()

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
            self.types[name] = []
        return self.type_names_map[name]

    def add_entry(self, res_type, name, value_bytes):
        self.type_idx(res_type)
        self.key(name)
        if not self.types[res_type]:
            self.types[res_type].append({})
        self.types[res_type][0][name] = value_bytes

    def _build_string_pool(self, strings, is_utf8=True):
        """Build ResStringPool chunk."""
        HEADER_SIZE = 28
        offsets = []
        body = bytearray()
        for s in strings:
            offsets.append(len(body))
            if is_utf8:
                enc = s.encode('utf-8') if isinstance(s, str) else s
                utflen = len(s.encode('utf-16-le')) // 2 if isinstance(s, str) else len(enc)
                body.append(utflen & 0x7F)
                body.append(len(enc) & 0x7F)
                body.extend(enc)
                body.append(0)
            else:
                enc = s.encode('utf-16-le') if isinstance(s, str) else s
                # UTF-16 string length is a uint16 (2 bytes). A single byte
                # corrupts the pool: the parser reads the length together
                # with the first character (e.g. "string" -> length 0x7306
                # = 29446) and fails with "string extends past end".
                body += u16(len(enc) // 2)
                body.extend(enc)
                body.append(0); body.append(0)
        while len(body) % 4: body.append(0)
        strings_start = HEADER_SIZE + 4 * len(strings)  # offset from chunk start
        fixed = bytearray()
        fixed += u32(len(strings))
        fixed += u32(0)  # styles
        fixed += u32(UTF8_FLAG if is_utf8 else 0)
        fixed += u32(strings_start)
        fixed += u32(0)  # styles start
        for o in offsets:
            fixed += u32(o)
        fixed += body
        return chunk_header(RES_STRING_POOL_TYPE, HEADER_SIZE, bytes(fixed))

    def _build_package(self):
        # Header size for ResTable_package is 0x120 (288)
        PKHDR_SIZE = 0x120
        type_pool = self._build_string_pool(self.type_names, is_utf8=False)
        key_pool = self._build_string_pool(self.key_strings, is_utf8=False)
        type_strings_off = PKHDR_SIZE
        key_strings_off = type_strings_off + len(type_pool)
        after_pools = key_strings_off + len(key_pool)

        # Build type spec and type chunks
        type_chunks = bytearray()
        for t_idx, tname in enumerate(self.type_names):
            entries_list = self.types[tname]
            n_entries = max(len(e) for e in entries_list)
            # ResTable_typeSpec: headerSize 16, fixed fields after chunk header are: id(1), res0(1), res1(2), count(4) = 8 bytes
            spec_body = bytearray()
            spec_body += u8(t_idx + 1); spec_body += u8(0); spec_body += u16(0)
            spec_body += u32(n_entries)
            for _ in range(n_entries):
                spec_body += u32(0)
            type_chunks += chunk_header(RES_TABLE_TYPE_SPEC_TYPE, 16, bytes(spec_body))

            type_entries = entries_list[0]
            sorted_keys = sorted(type_entries.keys(), key=lambda k: self.key_smap[k])
            n = len(sorted_keys)
            entries_data = bytearray()
            offsets_arr = []
            for k in sorted_keys:
                v = type_entries[k]
                off = len(entries_data)
                offsets_arr.append(off)
                entries_data += u16(8); entries_data += u16(0); entries_data += u32(self.key_smap[k])
                entries_data += v
            while len(entries_data) % 4: entries_data.append(0)

            config = b'\x00' * 64
            HEADER_TYPE = 0x54
            # Fixed fields after 8-byte chunk header: id(1), res0(1), res1(2), entryCount(4), entriesStart(4), config(64) = 76 bytes
            # headerSize = 84 (0x54)
            type_body = bytearray()
            type_body += u8(t_idx + 1); type_body += u8(0); type_body += u8(0); type_body += u8(0)
            type_body += u32(n)
            type_body += u32(HEADER_TYPE + 4*n)  # entries start (offset from chunk start)
            type_body += config
            for o in offsets_arr:
                type_body += u32(o)
            type_body += entries_data
            while len(type_body) % 4: type_body.append(0)
            type_chunks += chunk_header(RES_TABLE_TYPE_TYPE, HEADER_TYPE, bytes(type_body))

        # ResTable_package fixed header fields after 8 bytes: id(4), name(256), typeStrings(4), lastPublicType(4), keyStrings(4), lastPublicKey(4), typeIdOffset(4) = 280 bytes total? Wait:
        # headerSize = 0x120 = 288 bytes
        # Fixed: id(4) + name(256) + 5 * u32(20) = 280 bytes; 8 byte chunk header + 280 = 288 -> headerSize=288
        fixed = bytearray()
        fixed += u32(self.package_id)
        name_utf16 = self.package_name.encode('utf-16-le')[:256]
        name_utf16 = name_utf16 + b'\x00' * (256 - len(name_utf16))
        fixed += name_utf16
        fixed += u32(type_strings_off)
        fixed += u32(len(self.type_names) - 1 if self.type_names else 0)
        fixed += u32(key_strings_off)
        fixed += u32(len(self.key_strings) - 1 if self.key_strings else 0)
        fixed += u32(0)  # typeIdOffset
        assert len(fixed) == PKHDR_SIZE - 8, f"fixed fields len {len(fixed)} != {PKHDR_SIZE - 8}"
        pkg_body = bytes(fixed) + type_pool + key_pool + bytes(type_chunks)
        return chunk_header(RES_TABLE_PACKAGE_TYPE, PKHDR_SIZE, pkg_body)

    def build(self):
        global_pool = self._build_string_pool(self.global_strings, is_utf8=True)
        pkg_bytes = self._build_package()
        # ResTable headerSize = 12, fixed fields after chunk header: packageCount(4)
        body = u32(1) + global_pool + pkg_bytes
        return chunk_header(RES_TABLE_TYPE, 12, body)


def res_value(dtype, data):
    """Build an 8-byte Res_value struct."""
    return u16(8) + u8(0) + u8(dtype) + u32(data)

# Data type constants
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
