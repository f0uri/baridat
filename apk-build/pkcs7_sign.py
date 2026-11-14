"""
Minimal PKCS#7 SignedData DER builder using pyasn1.
Produces a detached signature suitable for APK v1 (JAR) signing.
"""
from pyasn1.type import univ, namedtype, tag, useful
from pyasn1.codec.der import encoder as der_enc
from pyasn1.codec.der import decoder as der_dec
import hashlib


# OIDs
PKCS7_SIGNED_DATA = '1.2.840.113549.1.7.2'
PKCS7_DATA = '1.2.840.113549.1.7.1'
SHA256 = '2.16.840.1.101.3.4.2.1'
SHA256_RSA = '1.2.840.113549.1.1.11'
CONTENT_TYPE = '1.2.840.113549.1.9.3'
MESSAGE_DIGEST = '1.2.840.113549.1.9.4'


def _oid(s):
    return univ.ObjectIdentifier(s)


def _null():
    return univ.Any(b'\x05\x00')


def _alg_id(oid):
    alg = univ.Sequence()
    alg.setComponentByPosition(0, _oid(oid))
    alg.setComponentByPosition(1, _null())
    return alg


def _len(n):
    if n < 0x80: return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b


def _tl(t, content):
    return bytes([t]) + _len(len(content)) + content


def make_pkcs7(cert_der, _sig_unused, sf_bytes, key):
    """Build CERT.RSA PKCS#7 detached signature (DER).

    - cert_der: DER-encoded X.509 certificate bytes
    - sf_bytes: .SF file bytes
    - key: RSA private key (cryptography)
    """
    # Parse cert to extract issuer + serial number using pyasn1 (from rfc2459-like)
    from pyasn1_modules import rfc2459

    cert, _ = der_dec.decode(cert_der, asn1Spec=rfc2459.Certificate())
    tbs = cert.getComponentByName('tbsCertificate')
    issuer = tbs.getComponentByName('issuer')
    serial = tbs.getComponentByName('serialNumber')

    # IssuerAndSerialNumber
    ias = univ.Sequence()
    ias.setComponentByPosition(0, issuer)
    ias.setComponentByPosition(1, serial)
    ias_der = der_enc.encode(ias)

    # Digest algorithms set
    sha256_alg = _alg_id(SHA256)
    digest_algs = _tl(0x31, der_enc.encode(sha256_alg))  # SET OF 1

    # EncapsulatedContentInfo (contentType + NO content — detached)
    # ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT ANY DEFINED BY contentType OPTIONAL }
    eci = _tl(0x30, der_enc.encode(_oid(PKCS7_DATA)))

    # Signed attributes (authenticated attributes) — SET containing:
    #   1. SEQUENCE { OID contentType, SET { OID pkcs7-data } }
    #   2. SEQUENCE { OID messageDigest, SET { OCTET STRING digest } }
    ct_attr = _tl(0x30,
        der_enc.encode(_oid(CONTENT_TYPE)) +
        _tl(0x31, der_enc.encode(_oid(PKCS7_DATA)))
    )
    content_digest = hashlib.sha256(sf_bytes).digest()
    md_attr = _tl(0x30,
        der_enc.encode(_oid(MESSAGE_DIGEST)) +
        _tl(0x31, der_enc.encode(univ.OctetString(content_digest)))
    )
    # SET (tag 0x31) of attrs — order by OID DER (contentType 2.16.840.1.101.3.1.6.3 = 9.3, messageDigest = 9.4) — CT < MD lexicographically
    # Actually signed attrs must be DER-encoded SET (tag 0x31). Signing is over the SET content.
    attrs_set = _tl(0x31, ct_attr + md_attr)
    # authenticated attrs in SignerInfo are [0] IMPLICIT SET (context-tag 0, constructed)
    auth_attrs_implicit = _tl(0xA0, attrs_set[1:])  # remove SET tag (31 len...), replace with A0
    # Wait — authenticated attributes are [0] IMPLICIT SET OF Attribute — so tag is A0, content is attribute entries (NO outer SET)
    auth_attrs_tagged = _tl(0xA0, ct_attr + md_attr)

    # Sign over the authenticated attributes (we sign over the DER-encoded SET)
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    signature = key.sign(attrs_set, padding.PKCS1v15(), hashes.SHA256())

    # SignerInfo: SEQUENCE { version=1, IAS, digestAlg, [0] authAttrs, sigAlg, sig }
    sig_alg = _alg_id(SHA256_RSA)
    signer_info = _tl(0x30,
        der_enc.encode(univ.Integer(1)) +
        ias_der +
        der_enc.encode(sha256_alg) +
        auth_attrs_tagged +
        der_enc.encode(sig_alg) +
        der_enc.encode(univ.OctetString(signature))
    )
    signer_infos = _tl(0x31, signer_info)  # SET OF

    # Certificates [0] IMPLICIT SET OF Certificate: the content is the cert
    # DER bytes directly (no SET tag, no SET length). Stripping only the tag
    # byte of the SET leaves the length bytes in place and strict parsers
    # (openssl, Android) reject the PKCS#7 at the certificates field.
    certs_tagged = _tl(0xA0, cert_der)

    # SignedData ::= SEQUENCE { version, digestAlgs, encapContentInfo, [0] certs, signerInfos }
    signed_data = _tl(0x30,
        der_enc.encode(univ.Integer(1)) +
        digest_algs +
        eci +
        certs_tagged +
        signer_infos
    )

    # Outer ContentInfo wrapping signed data: [0] EXPLICIT
    outer_content = _tl(0xA0, signed_data)
    outer = _tl(0x30,
        der_enc.encode(_oid(PKCS7_SIGNED_DATA)) +
        outer_content
    )
    return outer
