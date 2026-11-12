#!/usr/bin/env python3
"""Independent check of protocol/test-vectors/handshake-v2.json.

Elligator2 is implemented here from RFC 9380 (map_to_curve_elligator2, straight-line
form with constant-time style CMOV / sgn0 / sqrt), not translated from the JS or Swift
code. X25519, HKDF, HMAC and AES-GCM come from `cryptography`; tunnel frames are rebuilt
from the byte layout in packet-format.md.

    pip install cryptography && python3 protocol/xcheck.py
"""
import hashlib, hmac, json, struct, sys, unicodedata
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

p = 2**255 - 19
J, K = 486662, 1          # Montgomery A, B
Z = 2
c1 = (p + 3) // 8         # sqrt helpers for p ≡ 5 (mod 8)
c2 = pow(2, c1, p)        # = sqrt(-1)
inv = lambda x: pow(x, p - 2, p)


def is_square(x):
    return pow(x, (p - 1) // 2, p) in (0, 1)


def sqrt(x):  # RFC 9380 I.2 for p ≡ 5 mod 8
    tv1 = pow(x, c1, p)
    tv2 = tv1 * c2 % p
    return tv1 if tv1 * tv1 % p == x % p else tv2


def map_to_curve_elligator2(u):  # RFC 9380 §6.7.1 (returns s; t omitted)
    tv1 = Z * u * u % p
    e1 = tv1 == p - 1
    tv1 = 0 if e1 else tv1
    x1 = (tv1 + 1) % p
    x1 = inv(x1)                       # inv0(0) == 0
    x1 = (-J * x1) % p
    gx1 = (x1 + J) % p
    gx1 = gx1 * x1 % p
    gx1 = (gx1 + K) % p
    gx1 = gx1 * x1 % p                 # x1^3 + J x1^2 + x1
    x2 = (-x1 - J) % p
    gx2 = tv1 * gx1 % p
    e2 = is_square(gx1)
    x = x1 if e2 else x2
    return x


def le(b): return int.from_bytes(b, 'little')
def le32(x): return x.to_bytes(32, 'little')
H = bytes.fromhex


def generator(pw):
    h = bytearray(hashlib.sha256(b'PB2-cpace-generator' + unicodedata.normalize('NFC', pw).encode()).digest())
    h[31] &= 0x7f
    return le32(map_to_curve_elligator2(le(h) % p))


def x25519(scalar, u):
    out = X25519PrivateKey.from_private_bytes(scalar).exchange(X25519PublicKey.from_public_bytes(u))
    assert out != bytes(32)
    return out


def main(path):
    v = json.loads(Path(path).read_text())
    assert v['version'] == 3
    for m in v['elligator2']:
        assert le32(map_to_curve_elligator2(le(H(m['r'])))).hex() == m['u'], m
    for g in v['generators']:
        assert generator(g['password']).hex() == g['G'], g['password']

    h = v['handshake']
    G = generator(h['password']); assert G.hex() == h['G']
    Ya, Yb = x25519(H(h['ya']), G), x25519(H(h['yb']), G)
    assert Ya.hex() == h['Ya'] and Yb.hex() == h['Yb']
    k = x25519(H(h['ya']), Yb); assert k == x25519(H(h['yb']), Ya) and k.hex() == h['K']
    tr = b'PB2' + H(h['device']) + Ya + Yb + H(h['na']) + H(h['nb']); assert tr.hex() == h['transcript']
    okm = HKDF(hashes.SHA256(), 128, b'', b'PB2-keys' + tr).derive(k); assert okm.hex() == h['okm']
    assert hmac.new(okm[0:32], b'P' + tr, 'sha256').hexdigest() == h['macP']
    assert hmac.new(okm[32:64], b'C' + tr, 'sha256').hexdigest() == h['macC']

    s = v['secure']
    nonce = bytes(12)
    for key, plain, payload in ((okm[64:96], 'c2pPlain', 'c2pPayload'), (okm[96:128], 'p2cPlain', 'p2cPayload')):
        ct = AESGCM(key).encrypt(nonce, H(s[plain]), b'PB2')
        assert (b'\x02' + bytes(8) + ct).hex() == s[payload], payload

    def tunnel(op, stream, payload=b''):
        return bytes([0x04, op]) + struct.pack('>I', stream) + payload
    expected = {
        'CONNECT': tunnel(0x01, 1, struct.pack('>H', 443) + b'example.com'),
        'OPENED': tunnel(0x02, 1),
        'DATA': tunnel(0x03, 0xabcdef01, bytes([0x16, 0x03, 0x01])),
        'CLOSE': tunnel(0x04, 2, bytes([3])),
    }
    for t in v['tunnel']:
        assert H(t['frame']) == expected[t['op']], t['op']
    assert H(s['p2cPlain']) == tunnel(0x03, 7, b'hello body')
    print('xcheck: independent implementation agrees with all vectors (crypto + tunnel frames)')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name('test-vectors') / 'handshake-v2.json')
