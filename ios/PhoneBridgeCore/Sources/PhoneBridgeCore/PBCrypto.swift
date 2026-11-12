import Foundation
import CryptoKit

/// v2 handshake primitives: CPace-style password PAKE over X25519.
/// Mirrors chromebook/extension/src/crypto.js; pinned by protocol/test-vectors/handshake-v2.json.
public enum PBCrypto {
    static func tag(_ s: String) -> Data { Data(s.utf8) }

    public static func randomBytes(_ count: Int) -> Data {
        SymmetricKey(size: SymmetricKeySize(bitCount: count * 8)).withUnsafeBytes { Data($0) }
    }

    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    public static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    public static func hmacValid(_ mac: Data, key: Data, data: Data) -> Bool {
        HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: data, using: SymmetricKey(data: key))
    }

    public static func hkdf(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info,
                               outputByteCount: length).withUnsafeBytes { Data($0) }
    }

    /// Password → X25519 base point (u-coordinate, 32 bytes LE). Done once per password.
    public static func generator(password: String) -> Data {
        var h = sha256(tag("PB2-cpace-generator") + Data(password.precomposedStringWithCanonicalMapping.utf8))
        h[h.startIndex + 31] &= 0x7f
        return FieldElement.elligator2(FieldElement(bytesLE: h)).bytesLE
    }

    public enum Failure: Error { case zeroPoint }

    /// X25519(scalar, u) for an arbitrary base point u.
    public static func x25519(_ key: Curve25519.KeyAgreement.PrivateKey, _ u: Data) throws -> Data {
        let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: u)
        let out = try key.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) }
        guard out.contains(where: { $0 != 0 }) else { throw Failure.zeroPoint }
        return out
    }

    public static func transcript(device: Data, ya: Data, yb: Data, na: Data, nb: Data) -> Data {
        var d = tag("PB2")
        d.append(device); d.append(ya); d.append(yb); d.append(na); d.append(nb)
        return d
    }

    public struct Keys {
        public let confirmP: Data
        public let confirmC: Data
        public let c2p: SymmetricKey
        public let p2c: SymmetricKey
        public let okm: Data
    }

    public static func deriveKeys(shared k: Data, transcript tr: Data) -> Keys {
        let okm = hkdf(ikm: k, salt: Data(), info: tag("PB2-keys") + tr, length: 128)
        return Keys(confirmP: okm.subdata(in: 0..<32), confirmC: okm.subdata(in: 32..<64),
                    c2p: SymmetricKey(data: okm.subdata(in: 64..<96)), p2c: SymmetricKey(data: okm.subdata(in: 96..<128)),
                    okm: okm)
    }

    public static func macP(_ keys: Keys, _ tr: Data) -> Data { hmac(keys.confirmP, tag("P") + tr) }
    public static func macC(_ keys: Keys, _ tr: Data) -> Data { hmac(keys.confirmC, tag("C") + tr) }
    public static func verifyC(_ keys: Keys, _ tr: Data, _ mac: Data) -> Bool { hmacValid(mac, key: keys.confirmC, data: tag("C") + tr) }
    public static func verifyP(_ keys: Keys, _ tr: Data, _ mac: Data) -> Bool { hmacValid(mac, key: keys.confirmP, data: tag("P") + tr) }
}

/// AES-256-GCM with per-direction keys and strict counters.
public final class SecureChannel {
    public enum Failure: Error { case malformed, counter(expected: UInt64, got: UInt64) }
    static let aad = Data("PB2".utf8)

    private let sendKey: SymmetricKey
    private let recvKey: SymmetricKey
    public private(set) var sendCounter: UInt64 = 0
    public private(set) var recvCounter: UInt64 = 0

    public init(sendKey: SymmetricKey, recvKey: SymmetricKey) {
        self.sendKey = sendKey
        self.recvKey = recvKey
    }

    static func nonce(_ counter: UInt64) -> Data {
        var d = Data(count: 4)
        d.appendBE(counter)
        return d
    }

    /// Returns a complete outer payload: 0x02 | u64 counter | ciphertext | tag.
    public func seal(_ plaintext: Data) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: sendKey,
                                   nonce: try AES.GCM.Nonce(data: Self.nonce(sendCounter)),
                                   authenticating: Self.aad)
        var out = Data([PBWire.Outer.secure.rawValue])
        out.appendBE(sendCounter)
        out.append(box.ciphertext)
        out.append(box.tag)
        sendCounter += 1
        return out
    }

    public func open(_ payload: Data) throws -> Data {
        let p = Data(payload)
        guard p.count >= 1 + 8 + 16, p[0] == PBWire.Outer.secure.rawValue,
              let counter = p.readBE(UInt64.self, at: 1) else { throw Failure.malformed }
        guard counter == recvCounter else { throw Failure.counter(expected: recvCounter, got: counter) }
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: Self.nonce(counter)),
                                        ciphertext: p.subdata(in: 9..<(p.count - 16)),
                                        tag: p.subdata(in: (p.count - 16)..<p.count))
        let plain = try AES.GCM.open(box, using: recvKey, authenticating: Self.aad)
        recvCounter += 1
        return plain
    }
}
