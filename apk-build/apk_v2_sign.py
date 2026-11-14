"""
APK Signature Scheme v2 implementation (pure Python).
Places an APK Signing Block between the file entries and central directory.
Signs with the same RSA key + cert used for v1.
"""
import struct, hashlib


def _u16(v): return struct.pack('<H', v & 0xFFFF)
def _u32(v): return struct.pack('<I', v & 0xFFFFFFFF)
def _u64(v): return struct.pack('<Q', v & 0xFFFFFFFFFFFFFFFF)

# Algorithm IDs:
ALGO_SHA256_RSA = 0x0103
ALGO_SHA256 = 0x03  # digest for chunk


def _length_prefix_bytes(data):
    return _u32(len(data)) + data


def _pair(id_, value_bytes):
    """ID-value pair (uint32 id + value bytes prefixed with uint32 length)."""
    return _u32(id_) + _u32(len(value_bytes)) + value_bytes


def _compute_data_digest(data, chunk_size=1024*1024):
    """Split data into 1MB chunks, compute SHA-256 of each, then hash the concatenation."""
    h = hashlib.sha256()
    i = 0
    while i < len(data):
        chunk = data[i:i+chunk_size]
        h.update(hashlib.sha256(chunk).digest())
        i += chunk_size
    return h.digest()


def _build_signer_block(key, cert_der, digests):
    """Build the signer block for v2.
    signer = length-prefixed:
      signed data (length-prefixed):
        digests: length-prefixed sequence of length-prefixed pairs (algo_id=u32 + digest)
        certificates: length-prefixed sequence of length-prefixed cert DER
        additional attributes: empty length-prefixed
      signatures: length-prefixed sequence of pairs (algo_id=u32, sig with algo over signed_data)
      public key (length-prefixed) — we use SubjectPublicKeyInfo DER
    """
    # Get SPKI
    pub_key_der = key.public_key().public_bytes(
        __import__('cryptography.hazmat.primitives.serialization', fromlist=['serialization']).Encoding.DER,
        __import__('cryptography.hazmat.primitives.serialization', fromlist=['serialization']).PublicFormat.SubjectPublicKeyInfo,
    )

    # Build digests
    digests_data = b''
    for algo_id, digest in digests:
        digests_data += _u32(algo_id) + _length_prefix_bytes(digest)
    digests_section = _length_prefix_bytes(digests_data)

    # Certificates
    certs_section = _length_prefix_bytes(_length_prefix_bytes(cert_der))

    # Additional attributes (empty)
    add_attrs = _u32(0)

    signed_data = digests_section + certs_section + add_attrs
    signed_data_prefixed = _length_prefix_bytes(signed_data)

    # Sign signed_data with SHA-256 + PKCS1v15
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    signature = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())

    sigs_data = _u32(ALGO_SHA256_RSA) + _length_prefix_bytes(signature)
    sigs_section = _length_prefix_bytes(sigs_data)

    pub_section = _length_prefix_bytes(pub_key_der)

    signer_block = signed_data_prefixed + sigs_section + pub_section
    return _length_prefix_bytes(signer_block)


def add_v2_signature(apk_path, key, cert_der):
    """Read the APK file, insert v2 APK Signing Block before the central directory, write back."""
    with open(apk_path, 'rb') as f:
        data = f.read()

    # Find End of Central Directory (EOCD) — last 22 bytes + comment
    # EOCD signature = 0x06054b50. Search from end backwards for up to 64KB comment.
    eocd_sig = b'PK\x05\x06'
    search_start = max(0, len(data) - 65557)
    eocd_pos = data.rfind(eocd_sig, search_start)
    if eocd_pos < 0:
        raise RuntimeError("No EOCD found")
    eocd = data[eocd_pos:]
    # Parse EOCD
    _, disk, cd_disk, _dc, _tc, cd_size, cd_off, comment_len = struct.unpack('<IHHHHIIH', eocd[:22])
    cd_start = cd_off

    # Data before CD
    before_cd = data[:cd_start]
    cd_data = data[cd_start:eocd_pos]
    eocd_data = eocd  # original EOCD (includes comment)

    # Compute digests of three sections
    digest = hashlib.sha256()
    # 1. Contents (before_cd)
    digest.update(_compute_data_digest(before_cd, 1024*1024))
    # 2. Central directory (cd_data)
    digest.update(_compute_data_digest(cd_data, 1024*1024))
    # 3. EOCD (without the comment and the 22 bytes of EOCD header? — actually scheme v2 hashes eocd except its comment field)
    eocd_no_comment = eocd[:22]
    digest.update(_compute_data_digest(eocd_no_comment, 1024*1024))
    content_digest = digest.digest()

    # Build signer block
    signer = _build_signer_block(key, cert_der, [(ALGO_SHA256, content_digest)])
    signers_section = _length_prefix_bytes(signer)

    # APK Signing Block v2 (id = 0x7109871a)
    signing_block_value = signers_section
    pair_v2 = _pair(0x7109871a, signing_block_value)

    # Block size = 8 (size of size fields) + 16 (magic) + len(pairs)
    block_pairs = pair_v2
    block_size = 8 + len(block_pairs) + 16
    # Align block size to 4096 boundary (unnecessary but common)
    signing_block = _u64(block_size) + block_pairs + _u64(block_size) + b'APK Sig Block 42'

    # New CD offset = cd_off + len(signing_block)
    new_cd_start = cd_start + len(signing_block)

    # Build new EOCD with updated cd_off
    new_eocd = bytearray(eocd_no_comment)
    struct.pack_into('<I', new_eocd, 16, new_cd_start)
    new_eocd += eocd[22:22+comment_len]  # preserve original comment

    new_data = before_cd + signing_block + cd_data + bytes(new_eocd)

    with open(apk_path, 'wb') as f:
        f.write(new_data)
    return apk_path


if __name__ == '__main__':
    import sys
    print("Use add_v2_signature(apk_path, key, cert_der)")
