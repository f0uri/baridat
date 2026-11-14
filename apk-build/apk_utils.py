"""
APK utilities: zipalign, proper ZIP construction, v2 signature.
"""
import os, struct, hashlib, io, zipfile
from pathlib import Path


def build_aligned_apk(entries, out_path, alignment=4):
    """Build a ZIP file with proper zipalign.
    
    entries: list of (name, data_bytes, compress_type) — compress_type is zipfile.ZIP_STORED or ZIP_DEFLATED.
    
    Critical rules for APK validity:
    - All entries must have local file header
    - STORED entries (especially META-INF, resources.arsc, AndroidManifest.xml, classes.dex) 
      must start at a 4-byte-aligned offset from the start of the file (measured to start of data).
    - META-INF files must be STORED.
    """
    # First, write all entries to memory, tracking their offsets.
    # We need to write sequentially with padding before each STORED entry to ensure alignment.
    
    buf = io.BytesIO()
    central_dir = bytearray()
    
    for name, data, compress_type in entries:
        name_bytes = name.encode('utf-8')
        
        # Compress data if needed
        if compress_type == zipfile.ZIP_DEFLATED:
            import zlib
            compressed = zlib.compress(data, 9)[2:-4]  # strip zlib header/adler to get raw deflate
            crc = binascii_crc32(data)
            comp_size = len(compressed)
            uncomp_size = len(data)
            # We don't pad compressed entries (they can be at any offset; only STORED need alignment for mmap)
        else:
            compressed = data
            crc = binascii_crc32(data)
            comp_size = len(data)
            uncomp_size = len(data)
        
        # Calculate current position where local header starts
        pos = buf.tell()
        local_header_start = pos
        # Local file header is 30 bytes + len(name) + len(extra)
        header_size = 30 + len(name_bytes)
        data_start = local_header_start + header_size
        
        # Need alignment padding if STORED
        extra = b''
        if compress_type == zipfile.ZIP_STORED and data_start % alignment != 0:
            pad_needed = alignment - (data_start % alignment)
            extra = b'\x00' * pad_needed
            # Recalculate data_start after adding extra
            data_start = local_header_start + 30 + len(name_bytes) + len(extra)
        
        # Write local file header
        dos_time = 0x5420  # 10:33
        dos_date = 0x586A  # 2024-03-10
        flags = 0
        ver = 20  # 2.0
        internal_attr = 0
        if name.endswith('/'):
            external_attr = (0o040755 << 16)
        else:
            external_attr = (0o100644 << 16)
        
        lfh = bytearray()
        lfh += struct.pack('<IHHHHHIIIHH',
            0x04034b50,  # signature
            ver,
            flags,
            compress_type,
            dos_time,
            dos_date,
            crc,
            comp_size,
            uncomp_size,
            len(name_bytes),
            len(extra),
        )
        lfh += name_bytes
        lfh += extra
        buf.write(bytes(lfh))
        buf.write(compressed)
        
        # Data descriptor not used since we know CRC/size upfront
        
        # Central directory entry
        # CDE extra: keep same extra as local header for alignment info
        cde_extra = extra
        cde = bytearray()
        # Central directory entry layout (46 bytes fixed + name + extra):
        # sig(4) ver_made(2) ver_need(2) flags(2) method(2) time(2) date(2)
        # crc(4) csize(4) usize(4) fnlen(2) exlen(2) clen(2) disk(2) iattr(2) eattr(4) off(4)
        # 17 fields total: I + 6H + 3I + 5H + 2I = 46 bytes
        cde += struct.pack('<IHHHHHHIIIHHHHHII',
            0x02014b50,
            0x0314,
            ver,
            flags,
            compress_type,
            dos_time,
            dos_date,
            crc,
            comp_size,
            uncomp_size,
            len(name_bytes),
            len(cde_extra),
            0,  # comment length
            0,  # disk number start
            internal_attr,
            external_attr,
            local_header_start,
        )
        cde += name_bytes
        cde += cde_extra
        central_dir += bytes(cde)
    
    # End of central directory
    cd_start = buf.tell()
    buf.write(central_dir)
    cd_size = len(central_dir)
    
    eocd = struct.pack('<IHHHHIIH',
        0x06054b50,
        0, 0,
        len(entries),
        len(entries),
        cd_size,
        cd_start,
        0,
    )
    buf.write(eocd)
    
    # Write to file
    with open(out_path, 'wb') as f:
        f.write(buf.getvalue())
    
    return out_path


def binascii_crc32(data):
    """Compute CRC-32 as unsigned 32-bit."""
    import zlib
    return zlib.crc32(data) & 0xFFFFFFFF


def verify_alignment(apk_path, alignment=4):
    """Check all STORED entries are aligned. Return True if OK."""
    import zipfile
    z = zipfile.ZipFile(apk_path)
    for info in z.infolist():
        if info.compress_type == zipfile.ZIP_STORED:
            name_len = len(info.filename.encode('utf-8'))
            # Read the local file header to get extra field length (authoritative)
            with open(apk_path, 'rb') as f:
                f.seek(info.header_offset)
                sig = struct.unpack('<I', f.read(4))[0]
                assert sig == 0x04034b50
                f.read(2)  # ver
                f.read(2)  # flags
                f.read(2)  # comp
                f.read(4)  # time/date
                f.read(4)  # crc
                f.read(4)  # csize
                f.read(4)  # usize
                fn_len = struct.unpack('<H', f.read(2))[0]
                ex_len = struct.unpack('<H', f.read(2))[0]
                data_off = info.header_offset + 30 + fn_len + ex_len
                if data_off % alignment != 0:
                    print(f"  ⚠ MISALIGNED: {info.filename} @ 0x{data_off:x} mod {data_off % alignment}")
                    return False
    return True
