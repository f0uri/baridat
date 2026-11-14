"""
Minimal DEX file builder in pure Python — enough to encode a small Activity class.
"""
import struct, io

class ULEB128:
    @staticmethod
    def enc(val):
        out = bytearray()
        while True:
            b = val & 0x7F
            val >>= 7
            if val:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
        return bytes(out)

def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)
def sleb128(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if (v == 0 and (b & 0x40) == 0) or (v == -1 and (b & 0x40)):
            out.append(b)
            break
        out.append(b | 0x80)
    return bytes(out)

# Dalvik opcodes we need
OP = {
    'nop': 0x00,
    'move-result-object': 0x0B,  # op 0x0a=move-result, 0x0b=move-result-object, 0x0c=move-result-wide
    'return-void': 0x0E,
    'const/4': 0x12,
    'const/16': 0x13,
    'const': 0x14,
    'const-string': 0x1A,
    'new-instance': 0x22,
    'invoke-direct': 0x70,
    'invoke-virtual': 0x6E,
    'invoke-super': 0x6F,
    # formatted variants with range
}

# Invoke format for 35c (invoke-direct/virtual/super {vD, vE, vF, vG}, meth@BBBB):
# op AA BBBB CC CC CC CC CC  where A = count, B = method idx, C = registers packed in G,F,E,D order (4-bit each in last 4 bytes)
# Actually: 2-byte header: op (0x6E/70/6F) | A (count << 12 | regs? No — let me use exact format):
# Format 35c: [op, g|fedc] [meth]
#   byte 1: opcode
#   byte 2: A (argument count) | G (4 bits << 4)
#   uint16: method index
#   uint16: C (B=first reg of args array is register D, then E, F, G packed as 4-bit each in this word)
#           layout: FEDC where each is 4 bits, with first arg in D position.
# For invoke-range (format 3rc): [op, AA] [BBBB] [CCCC] where AA = count, BBBB = method, CCCC = start reg
# invoke-range is easier for 3+ args.

def pack_invoke35c(op, meth_idx, regs):
    """regs is a list of register indices (0..5 args for this format)."""
    A = len(regs)
    if A > 5:
        raise ValueError("35c supports max 5 args")
    word = 0
    for i, r in enumerate(regs):
        word |= (r & 0xF) << (i * 4)
    out = bytearray()
    out.append(op)
    out.append(((A & 0xF) << 4) | (regs[4] & 0xF) if A >= 5 else ((A & 0xF) << 4))
    out += u16(meth_idx)
    out += u16(word)
    return bytes(out)


class DexBuilder:
    def __init__(self):
        self.strings = []
        self.string_to_idx = {}
        self.types = []
        self.type_to_idx = {}
        self.protos = []
        self.proto_to_idx = {}
        self.fields = []
        self.field_to_idx = {}
        self.methods = []
        self.method_to_idx = {}
        self.class_defs_data = []  # list of dicts
        self.class_defs = []
        self._type_id_strings = []  # need to resolve type -> string idx after all strings added

    # ---- IDs ----
    def string(self, s):
        if s not in self.string_to_idx:
            self.string_to_idx[s] = len(self.strings)
            self.strings.append(s)
        return self.string_to_idx[s]

    def type(self, descriptor):
        # descriptor is a type descriptor string like 'V', 'Ljava/lang/Object;', '[I'
        # Ensure it's registered as a string first
        self.string(descriptor)
        if descriptor not in self.type_to_idx:
            idx = len(self.types)
            self.type_to_idx[descriptor] = idx
            self.types.append(descriptor)
        return self.type_to_idx[descriptor]

    def proto(self, return_type, param_types):
        key = (return_type, tuple(param_types))
        if key not in self.proto_to_idx:
            idx = len(self.protos)
            self.proto_to_idx[key] = idx
            self.protos.append((return_type, list(param_types)))
        return self.proto_to_idx[key]

    def field(self, class_type, name, type_):
        key = (class_type, name, type_)
        if key not in self.field_to_idx:
            idx = len(self.fields)
            self.field_to_idx[key] = idx
            self.fields.append(key)
        return self.field_to_idx[key]

    def method(self, class_type, name, proto_idx):
        key = (class_type, name, proto_idx)
        if key not in self.method_to_idx:
            idx = len(self.methods)
            self.method_to_idx[key] = idx
            self.methods.append(key)
        return self.method_to_idx[key]

    def cls(self, type_idx, access, super_idx, source_file=None):
        cdef = {
            'type': type_idx, 'access': access, 'super': super_idx,
            'source_file': source_file, 'interfaces': [],
            'methods': [],
        }
        self.class_defs.append(len(self.class_defs_data))
        self.class_defs_data.append(cdef)
        return cdef

    def add_method(self, cdef, method_idx, access, code_spec):
        cdef['methods'].append({'method': method_idx, 'access': access, 'code': code_spec})

    # ---- Build ----
    def build(self):
        # 1. Resolve type strings
        type_string_idx = []
        for t in self.types:
            # t is the descriptor string (already added as a string)
            type_string_idx.append(self.string_to_idx[t])

        # 2. Build proto data (shorty + return type + params)
        proto_shorty = []
        proto_return = []
        proto_params_off_data = []
        for ret_t, params in self.protos:
            # ret_t and params are type indices; resolve to descriptor strings
            ret_desc = self.types[ret_t]
            shorty = self._shorty(ret_desc)
            for p in params:
                pdesc = self.types[p]
                shorty += self._shorty(pdesc)
            shorty_idx = self.string(shorty)
            proto_shorty.append((shorty_idx, ret_t))
            proto_params_off_data.append(params)

        # 3. Build code items for methods
        # We need to encode each method's bytecode
        encoded_methods = []
        # We'll compute offsets later.

        # First pass: emit code items (one per method with code)
        code_items = []  # (class, method, code_bytes, insns_bytes, registers, ins, outs, tries)
        for cdef in self.class_defs_data:
            for m in cdef['methods']:
                if m['code']:
                    code = self._encode_code(m['code'])
                    code_items.append((cdef, m, code))

        # 4. Build string data section
        # Layout of DEX:
        # Header
        # string_ids
        # type_ids
        # proto_ids
        # field_ids
        # method_ids
        # class_defs
        # data:
        #   string_data items
        #   type_lists
        #   code_items
        #   encoded_methods (inside class_data)
        #   class_data_items
        #   map_list

        # We'll build sections in order, tracking offsets.
        # For simplicity, build everything into a single bytearray with known
        # section start offsets, then patch.

        HEADER_SIZE = 0x70
        num_strings = len(self.strings)
        num_types = len(self.types)
        num_protos = len(self.protos)
        num_fields = len(self.fields)
        num_methods = len(self.methods)
        num_classes = len(self.class_defs_data)

        # Section sizes:
        string_ids_size = num_strings * 4
        type_ids_size = num_types * 4
        proto_ids_size = num_protos * 12
        field_ids_size = num_fields * 8
        method_ids_size = num_methods * 8
        class_defs_size = num_classes * 32

        # Compute starting offsets (after header)
        off = HEADER_SIZE
        STRING_IDS_OFF = off; off += string_ids_size
        TYPE_IDS_OFF = off; off += type_ids_size
        PROTO_IDS_OFF = off; off += proto_ids_size
        FIELD_IDS_OFF = off; off += field_ids_size
        METHOD_IDS_OFF = off; off += method_ids_size
        CLASS_DEFS_OFF = off; off += class_defs_size

        # After class defs comes DATA section.
        DATA_START = off

        # We need to carefully build data section. Let's use a buffer.
        buf = io.BytesIO()

        def align_to(n=4):
            pos = buf.tell()
            pad = (n - pos % n) % n
            if pad:
                buf.write(b'\x00' * pad)

        # ---- String data ----
        # First write all string data, record offsets
        string_data_offsets = []
        for s in self.strings:
            buf.write(ULEB128.enc(len(s.encode('utf-16-le')) // 2))
            data = s.encode('utf-8') + b'\x00'  # MUTF-8 (simplified, assuming no null/surrogates)
            buf.write(data)
        # align
        align_to(4)

        # ---- Type lists (for proto params) ----
        proto_params_offsets = [0] * num_protos
        for i, params in enumerate(proto_params_off_data):
            if not params:
                proto_params_offsets[i] = 0
                continue
            align_to(4)
            proto_params_offsets[i] = DATA_START + buf.tell()
            buf.write(u32(len(params)))
            for p in params:
                buf.write(u16(p))
            align_to(4)

        # ---- Code items ----
        code_item_offsets = {}  # (cdef_idx, m_idx) -> offset
        # We need to track by index
        cdef_index_map = {id(cdef): i for i, cdef in enumerate(self.class_defs_data)}

        for cdef, m, code_bytes in code_items:
            align_to(4)
            key = (cdef_index_map[id(cdef)], m['method'])
            code_item_offsets[key] = DATA_START + buf.tell()
            buf.write(code_bytes)

        # ---- Class data items ----
        class_data_offsets = []
        for cdef in self.class_defs_data:
            align_to(4)
            class_data_offsets.append(DATA_START + buf.tell())
            self._emit_class_data(buf, cdef, code_item_offsets, cdef_index_map)

        # ---- Map list ----
        align_to(4)
        map_off = DATA_START + buf.tell()
        # Map entries: (type, count, offset). Type codes follow the DEX spec:
        # 0x0000 HEADER, 0x0001 STRING_ID, 0x0002 TYPE_ID, 0x0003 PROTO_ID,
        # 0x0004 FIELD_ID, 0x0005 METHOD_ID, 0x0006 CLASS_DEF, 0x1000 MAP_LIST,
        # 0x1001 TYPE_LIST, 0x2000 CLASS_DATA, 0x2001 CODE, 0x2002 STRING_DATA.
        # (An earlier build used type codes shifted down by one and omitted
        # CLASS_DEF / MAP_LIST / the data sections, which made strict DEX
        # parsers — and Android's installer — reject the APK as invalid.)
        # Entries must be sorted by type code. Empty sections are omitted.
        map_entries = []
        def add_map(t, c, o):
            if c > 0: map_entries.append((t, c, o))
        add_map(0x0000, 1, 0)  # header
        add_map(0x0001, num_strings, STRING_IDS_OFF)
        add_map(0x0002, num_types, TYPE_IDS_OFF)
        add_map(0x0003, num_protos, PROTO_IDS_OFF)
        add_map(0x0004, num_fields, FIELD_IDS_OFF)
        add_map(0x0005, num_methods, METHOD_IDS_OFF)
        add_map(0x0006, num_classes, CLASS_DEFS_OFF)
        add_map(0x1000, 1, map_off)  # map list itself
        _tl = [o for o in proto_params_offsets if o]
        add_map(0x1001, len(_tl), min(_tl) if _tl else 0)
        add_map(0x2000, num_classes, class_data_offsets[0] if class_data_offsets else 0)
        add_map(0x2001, len(code_items), min(code_item_offsets.values()) if code_item_offsets else 0)
        add_map(0x2002, num_strings, DATA_START)  # string data starts the data section
        map_entries.sort(key=lambda e: e[0])
        buf.write(u32(len(map_entries)))
        for t, c, o in map_entries:
            buf.write(u16(t))
            buf.write(u16(0))  # unused
            buf.write(u32(c))
            buf.write(u32(o))
        align_to(4)

        data = buf.getvalue()

        # ---- Assemble full DEX ----
        out = bytearray()
        # Header
        out += b'dex\n' + b'039\x00'  # magic/version
        out += b'\x00' * 4  # checksum placeholder
        out += b'\x00' * 20  # signature placeholder
        file_size = HEADER_SIZE + string_ids_size + type_ids_size + proto_ids_size + field_ids_size + method_ids_size + class_defs_size + len(data)
        out += u32(file_size)
        out += u32(HEADER_SIZE)  # header size
        out += u32(0x12345678)  # endian constant (little-endian)
        # link section
        out += u32(0); out += u32(0)
        # map off
        out += u32(map_off)
        # string ids
        out += u32(num_strings); out += u32(STRING_IDS_OFF if num_strings else 0)
        # type ids
        out += u32(num_types); out += u32(TYPE_IDS_OFF if num_types else 0)
        # proto ids
        out += u32(num_protos); out += u32(PROTO_IDS_OFF if num_protos else 0)
        # field ids
        out += u32(num_fields); out += u32(FIELD_IDS_OFF if num_fields else 0)
        # method ids
        out += u32(num_methods); out += u32(METHOD_IDS_OFF if num_methods else 0)
        # class defs
        out += u32(num_classes); out += u32(CLASS_DEFS_OFF if num_classes else 0)
        # data section
        out += u32(len(data)); out += u32(DATA_START)

        assert len(out) == HEADER_SIZE, f"Header size {len(out)}"

        # String IDs
        # We need the offset of each string data. But we wrote string data first in buffer.
        # Recompute string offsets by walking the string data we wrote.
        str_data_base = DATA_START
        # Compute per-string offsets by re-serializing
        string_data_offsets = []
        sbuf = io.BytesIO()
        for s in self.strings:
            string_data_offsets.append(str_data_base + sbuf.tell())
            sbuf.write(ULEB128.enc(len(s.encode('utf-16-le')) // 2))
            sbuf.write(s.encode('utf-8') + b'\x00')
        for off_ in string_data_offsets:
            out += u32(off_)

        # Type IDs
        for s_idx in type_string_idx:
            out += u32(s_idx)

        # Proto IDs
        for i, (shorty_idx, ret_t) in enumerate(proto_shorty):
            out += u32(shorty_idx)
            out += u32(ret_t)
            out += u32(proto_params_offsets[i])

        # Field IDs: class_idx(u16) type_idx(u16) name_idx(u32)
        for class_t, name_s, type_t in self.fields:
            name_idx = name_s if isinstance(name_s, int) else self.string_to_idx[name_s]
            out += u16(class_t)
            out += u16(type_t)
            out += u32(name_idx)

        # Method IDs: class_idx(u16) proto_idx(u16) name_idx(u32)
        for class_t, name_s, proto_idx in self.methods:
            name_idx = name_s if isinstance(name_s, int) else self.string_to_idx[name_s]
            out += u16(class_t)
            out += u16(proto_idx)
            out += u32(name_idx)

        # Class defs
        for i, cdef in enumerate(self.class_defs_data):
            out += u32(cdef['type'])
            out += u32(cdef['access'])
            out += u32(cdef['super'])
            out += u32(0)  # interfaces off
            out += u32(0)  # source file
            out += u32(0)  # annotations
            out += u32(0)  # class data off (patch later)
            out += u32(0)  # static values
        # Patch class data offsets
        cd_off_patch = CLASS_DEFS_OFF + 32 - 8  # class_data_off is 24 bytes into class_def
        for i, cd_off in enumerate(class_data_offsets):
            pos = CLASS_DEFS_OFF + i * 32 + 24
            out[pos:pos+4] = u32(cd_off)

        # Append data
        out += data

        assert len(out) == file_size, f"Size mismatch: {len(out)} vs {file_size}"

        # Compute SHA1 signature
        import hashlib
        sig = hashlib.sha1(out[32:]).digest()
        out[12:32] = sig
        # Compute Adler32 checksum
        import zlib as z
        chk = z.adler32(out[12:]) & 0xFFFFFFFF
        out[8:12] = u32(chk)

        return bytes(out)

    def _shorty(self, desc):
        c = desc[0]
        if c == '[':
            return 'L'
        if c == 'L':
            return 'L'
        if c == 'V': return 'V'
        if c == 'Z': return 'Z'
        if c in 'BSCIJFD':
            return c
        return 'L'

    def _encode_code(self, code_spec):
        """Emit a code_item (registers, ins, outs, insns, tries padding, catch handlers).
        Returns bytes for the code item."""
        registers = None; ins = 0; outs = 0
        insns = bytearray()
        for instr in code_spec:
            op = instr[0]
            if op == 'registers': registers = instr[1]
            elif op == 'ins': ins = instr[1]
            elif op == 'outs': outs = instr[1]
            elif op == 'return-void':
                insns.append(0x0E); insns.append(0x00)  # 1 unit (16-bit) padded
            elif op == 'const':
                # const/4 vA, #+B  — format 11n
                # For val fitting in 4 bits signed
                v = instr[1]['reg']; val = instr[1]['val']
                if -8 <= val <= 7:
                    # const/4: op vA|BBBB
                    A = v & 0xF
                    B = val & 0xF
                    insns.append(0x12)
                    insns.append((A << 4) | (B & 0xF))
                else:
                    # const/16: op AA, BBBB
                    if -32768 <= val <= 32767:
                        A = v & 0xFF
                        insns.append(0x13)
                        insns.append(A)
                        insns += u16(val & 0xFFFF)
                    else:
                        # const: op AA, BBBB BBBB
                        A = v & 0xFF
                        insns.append(0x14)
                        insns.append(A)
                        insns += u32(val & 0xFFFFFFFF)
            elif op == 'const-string':
                v = instr[1]['reg']; s = instr[1]['string']
                if isinstance(s, int):
                    s_idx = s
                else:
                    s_idx = self.string_to_idx[s]
                if s_idx <= 0xFF:
                    # const-string/4 (op 0x1A is const-string with AA BBBB)
                    insns.append(0x1A)
                    insns.append(v & 0xFF)
                    insns += u16(s_idx)
                else:
                    # const-string/jumbo (op 0x1B)
                    insns.append(0x1B)
                    insns.append(v & 0xFF)
                    insns += u32(s_idx)
            elif op == 'new-instance':
                v = instr[1]['reg']; t = instr[1]['type']
                insns.append(0x22); insns.append(v & 0xFF); insns += u16(t)
            elif op == 'invoke-direct':
                insns += self._emit_invoke(0x70, instr[1])
            elif op == 'invoke-virtual':
                insns += self._emit_invoke(0x6E, instr[1])
            elif op == 'invoke-super':
                insns += self._emit_invoke(0x6F, instr[1])
            elif op == 'move-result-object':
                v = instr[1]['reg']
                insns.append(0x0B)  # 0x0a=move-result (int), 0x0b=move-result-object (ref), 0x0c=move-result-wide (long/double)
                insns.append(v & 0xFF)

        # Insns size is in 16-bit code units. Pad to 2-byte boundary.
        if len(insns) % 2: insns.append(0)
        insns_size = len(insns) // 2

        out = bytearray()
        out += u16(registers or 1)
        out += u16(ins)
        out += u16(outs)
        out += u16(0)  # tries size
        out += u32(0)  # debug info off
        out += u32(insns_size)
        out += insns
        # padding for tries (if tries, align to 4)
        while len(out) % 4: out.append(0)
        # (no tries, no handlers)
        return bytes(out)

    def _emit_invoke(self, base_op, info):
        method_idx = info['method']
        regs = list(info['regs'])
        # 35c for 0..5 args, 3rc for more
        n = len(regs)
        if n <= 5:
            # pack
            out = bytearray()
            A = n
            G = regs[4] & 0xF if n >= 5 else 0
            out.append(base_op)
            out.append((A << 4) | G)
            out += u16(method_idx)
            # pack C word: F E D C (reg index in arg list order is D=regs[0], E=regs[1], F=regs[2], then G in byte2)
            D = regs[0] & 0xF if n >= 1 else 0
            E = regs[1] & 0xF if n >= 2 else 0
            F = regs[2] & 0xF if n >= 3 else 0
            A_ = regs[3] & 0xF if n >= 4 else 0
            word = D | (E << 4) | (F << 8) | (A_ << 12)
            out += u16(word)
            return bytes(out)
        else:
            # invoke-virtual/range (3rc): op AA, BBBB, CCCC
            op_range = base_op | 3  # 0x6E | 3 = 0x71? — actually invoke-virtual/range is 0x74.
            # invoke-kind/range opcodes: virtual/range=0x74, super/range=0x75, direct/range=0x76
            range_ops = {0x6E: 0x74, 0x6F: 0x75, 0x70: 0x76}
            r_op = range_ops[base_op]
            start = regs[0]
            # ensure contiguous
            for i, r in enumerate(regs):
                if r != start + i:
                    raise ValueError(f"invoke-range requires contiguous registers; got {regs}")
            out = bytearray()
            out.append(r_op)
            out.append(n & 0xFF)
            out += u16(method_idx)
            out += u16(start)
            return bytes(out)

    def _emit_class_data(self, buf, cdef, code_item_offsets, cdef_index_map):
        # ULEB128: static_fields_size, instance_fields_size, direct_methods_size, virtual_methods_size
        static_fields = []
        instance_fields = []
        direct_methods = []
        virtual_methods = []
        for m in cdef['methods']:
            acc = m['access']
            # Direct methods: static methods (ACC_STATIC=0x8) and constructors (ACC_CONSTRUCTOR=0x10000)
            if (acc & 0x0008) or (acc & 0x10000):
                direct_methods.append(m)
            else:
                virtual_methods.append(m)
        buf.write(ULEB128.enc(len(static_fields)))
        buf.write(ULEB128.enc(len(instance_fields)))
        buf.write(ULEB128.enc(len(direct_methods)))
        buf.write(ULEB128.enc(len(virtual_methods)))

        def emit_method_list(mlist):
            prev_idx = 0
            for m in mlist:
                midx = m['method']
                # diff
                buf.write(ULEB128.enc(midx - prev_idx))
                prev_idx = midx
                buf.write(ULEB128.enc(m['access']))
                if m['code']:
                    key = (cdef_index_map[id(cdef)], m['method'])
                    coff = code_item_offsets.get(key, 0)
                    buf.write(ULEB128.enc(coff))
                else:
                    buf.write(ULEB128.enc(0))

        # Static fields (none)
        for flist in (static_fields, instance_fields):
            prev_idx = 0
            for f in flist:
                buf.write(ULEB128.enc(f - prev_idx)); prev_idx = f
                buf.write(ULEB128.enc(0))
        emit_method_list(direct_methods)
        emit_method_list(virtual_methods)
