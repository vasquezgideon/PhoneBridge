import Foundation
import CryptoKit

public struct SessionKeys {
    public let c2p: SymmetricKey
    public let p2c: SymmetricKey
    public let okm: Data
}

/// Handshake primitives. Every function mirrors chromebook/src/crypto.js and is
/// pinned by protocol/test-vectors/handshake-v1.json.
public enum PBCrypto {
    static func tag(_ s: String) -> Data { Data(s.utf8) }

    public static func randomBytes(_ count: Int) -> Data {
        SymmetricKey(size: SymmetricKeySize(bitCount: count * 8)).withUnsafeBytes { Data($0) }
    }

    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    public static func hmac(_ key: SymmetricKey, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: key))
    }

    public static func hkdf(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info,
                               outputByteCount: length).withUnsafeBytes { Data($0) }
    }

    public static func ecdh(_ privateKey: P256.KeyAgreement.PrivateKey, peer: Data) throws -> Data {
        let pub = try P256.KeyAgreement.PublicKey(x963Representation: peer)
        return try privateKey.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) }
    }

    public static func transcript(label: String, device: Data, pkA: Data, pkB: Data, na: Data, nb: Data) -> Data {
        var d = tag(label)
        d.append(device); d.append(pkA); d.append(pkB); d.append(na); d.append(nb)
        return d
    }

    public static func commit(device: Data, pkA: Data, pkB: Data, nb: Data) -> Data {
        var d = tag("PB-commit-v1")
        d.append(device); d.append(pkA); d.append(pkB); d.append(nb)
        return sha256(d)
    }

    public static func sas(transcript: Data) -> String {
        let h = sha256(tag("PB-sas-v1") + transcript)
        let v = h.readBE(UInt32.self, at: 0)! % 1_000_000
        let s = String(v)
        return String(repeating: "0", count: 6 - s.count) + s
    }

    public static func trustKey(shared: Data, transcript: Data) -> Data {
        hkdf(ikm: shared, salt: Data(), info: tag("PB-trust-v1") + transcript, length: 32)
    }

    public static func sessionKeys(shared: Data, trustKey: SymmetricKey, na: Data, nb: Data, transcript: Data) -> SessionKeys {
        let salt = hmac(trustKey, tag("PB-salt-v1") + na + nb)
        let okm = hkdf(ikm: shared, salt: salt, info: tag("PB-session-v1") + transcript, length: 64)
        return SessionKeys(c2p: SymmetricKey(data: okm.prefix(32)),
                           p2c: SymmetricKey(data: okm.suffix(32)),
                           okm: okm)
    }

    /// role: "C" (Chromebook) or "P" (phone).
    public static func confirmMAC(trustKey: SymmetricKey, role: String, transcript: Data) -> Data {
        hmac(trustKey, tag("PB-confirm-" + role) + transcript)
    }

    public static func verifyConfirm(trustKey: SymmetricKey, role: String, transcript: Data, mac: Data) -> Bool {
        HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: tag("PB-confirm-" + role) + transcript, using: trustKey)
    }

    public static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }
}

/// AES-256-GCM with per-direction keys and strict counters.
public final class SecureChannel {
    public enum Failure: Error { case malformed, counter(expected: UInt64, got: UInt64) }
    static let aad = Data("PB1".utf8)

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
