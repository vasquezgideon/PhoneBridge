import Foundation
import CryptoKit

/// Handshake JSON (outer type 0x01). Unused fields are omitted when encoding.
public struct HandshakeMessage: Codable, Equatable {
    public var t: String
    public var v: Int?
    public var device: String?
    public var name: String?
    public var pk: String?
    public var commit: String?
    public var n: String?
    public var mac: String?
    public var phone: String?
    public var phoneId: String?
    public var code: String?
    public var msg: String?

    public init(t: String) { self.t = t }

    public static func error(_ code: String, _ msg: String) -> HandshakeMessage {
        var m = HandshakeMessage(t: "error"); m.code = code; m.msg = msg; return m
    }

    public func payload() -> Data {
        var d = Data([PBWire.Outer.handshake.rawValue])
        d.append((try? JSONEncoder().encode(self)) ?? Data("{}".utf8))
        return d
    }

    public static func decode(_ payload: Data) -> HandshakeMessage? {
        guard payload.first == PBWire.Outer.handshake.rawValue else { return nil }
        return try? JSONDecoder().decode(HandshakeMessage.self, from: Data(payload.dropFirst()))
    }
}

public struct TrustedDevice: Codable, Equatable, Identifiable {
    public var id: String              // base64 of the Chromebook's 16-byte device ID
    public var name: String
    public var key: Data               // 32-byte trust key
    public var pairedAt: Date
    public var lastSeen: Date
    public var passwordRemembered: Bool

    public init(id: String, name: String, key: Data, pairedAt: Date = Date(), lastSeen: Date = Date(),
                passwordRemembered: Bool = false) {
        self.id = id; self.name = name; self.key = key
        self.pairedAt = pairedAt; self.lastSeen = lastSeen; self.passwordRemembered = passwordRemembered
    }
}

public protocol PhoneHandshakeDelegate: AnyObject {
    func handshake(_ h: PhoneHandshake, trustedDeviceFor id: String) -> TrustedDevice?
    func handshakePairingAllowed(_ h: PhoneHandshake) -> Bool
    /// Show the code + device name with Approve / Reject; call `h.approve(_:)` with the answer.
    func handshake(_ h: PhoneHandshake, requestApprovalFor code: String, deviceName: String)
    func handshake(_ h: PhoneHandshake, send payload: Data)
    func handshake(_ h: PhoneHandshake, completed device: TrustedDevice, channel: SecureChannel, newlyPaired: Bool)
    func handshake(_ h: PhoneHandshake, failed code: String, message: String, duringPairing: Bool)
}

/// Phone side of the v1 handshake. One instance per BLE connection.
public final class PhoneHandshake {
    public weak var delegate: PhoneHandshakeDelegate?
    public let phoneName: String
    public let phoneId: Data

    private struct PairContext {
        var device: Data
        var name: String
        var transcript: Data
        var trust: Data
        var keys: SessionKeys
        var approved: Bool?
        var confirmMAC: Data?
    }

    private enum State {
        case idle
        case pairAwaitNonce(device: Data, name: String, pkA: Data, key: P256.KeyAgreement.PrivateKey, nb: Data)
        case pairAwaitConfirm(PairContext)
        case resumeAwaitProof(device: TrustedDevice, transcript: Data, keys: SessionKeys)
        case done
        case failed
    }

    private var state: State = .idle
    public private(set) var pendingCode: String?

    public init(phoneName: String, phoneId: Data) {
        self.phoneName = phoneName
        self.phoneId = phoneId
    }

    public var isComplete: Bool { if case .done = state { return true }; return false }
    public var isPairing: Bool {
        switch state {
        case .pairAwaitNonce, .pairAwaitConfirm: return true
        default: return false
        }
    }

    public func receive(_ payload: Data) {
        guard let m = HandshakeMessage.decode(payload) else {
            return fail("bad_message", "Malformed handshake message")
        }
        if m.t == "error" {
            return fail(m.code ?? "remote_error", m.msg ?? "Chromebook cancelled", notifyPeer: false)
        }
        switch (m.t, state) {
        case ("pair_hello", .idle): pairHello(m)
        case ("pair_nonce", let .pairAwaitNonce(device, name, pkA, key, nb)):
            pairNonce(m, device: device, name: name, pkA: pkA, key: key, nb: nb)
        case ("pair_confirm", .pairAwaitConfirm(var ctx)):
            guard let mac = m.mac.flatMap({ Data(base64Encoded: $0) }) else { return fail("bad_message", "Missing MAC") }
            ctx.confirmMAC = mac
            state = .pairAwaitConfirm(ctx)
            finishPairingIfReady()
        case ("resume_hello", .idle): resumeHello(m)
        case ("resume_proof", let .resumeAwaitProof(device, transcript, keys)):
            resumeProof(m, device: device, transcript: transcript, keys: keys)
        default:
            fail("bad_message", "Unexpected \(m.t)")
        }
    }

    /// User tapped Approve / Reject on the phone.
    public func approve(_ ok: Bool) {
        guard case .pairAwaitConfirm(var ctx) = state else { return }
        guard ok else { return fail("rejected", "Pairing was rejected on the iPhone") }
        ctx.approved = true
        state = .pairAwaitConfirm(ctx)
        finishPairingIfReady()
    }

    /// Connection dropped or the app wants to abandon this attempt.
    public func cancel() {
        switch state {
        case .done, .failed: return
        default: state = .failed; pendingCode = nil
        }
    }

    // MARK: - Pairing

    private func pairHello(_ m: HandshakeMessage) {
        guard let delegate else { return }
        guard delegate.handshakePairingAllowed(self) else {
            return fail("pairing_closed", "Pairing is closed. On the iPhone, tap “Pair new Chromebook”, then try again.",
                        countsAsPairingFailure: false)
        }
        guard let device = m.device.flatMap({ Data(base64Encoded: $0) }), device.count == 16,
              let pkA = m.pk.flatMap({ Data(base64Encoded: $0) }), pkA.count == 65,
              (try? P256.KeyAgreement.PublicKey(x963Representation: pkA)) != nil else {
            return fail("bad_message", "Invalid pair_hello")
        }
        let key = P256.KeyAgreement.PrivateKey()
        let pkB = key.publicKey.x963Representation
        let nb = PBCrypto.randomBytes(16)
        let name = String((m.name ?? "Chromebook").prefix(64))
        state = .pairAwaitNonce(device: device, name: name, pkA: pkA, key: key, nb: nb)

        var out = HandshakeMessage(t: "pair_commit")
        out.pk = pkB.base64EncodedString()
        out.commit = PBCrypto.commit(device: device, pkA: pkA, pkB: pkB, nb: nb).base64EncodedString()
        out.phone = phoneName
        delegate.handshake(self, send: out.payload())
    }

    private func pairNonce(_ m: HandshakeMessage, device: Data, name: String, pkA: Data,
                           key: P256.KeyAgreement.PrivateKey, nb: Data) {
        guard let na = m.n.flatMap({ Data(base64Encoded: $0) }), na.count == 16 else {
            return fail("bad_message", "Invalid nonce")
        }
        let pkB = key.publicKey.x963Representation
        let tr = PBCrypto.transcript(label: "PB-pair-v1", device: device, pkA: pkA, pkB: pkB, na: na, nb: nb)
        guard let shared = try? PBCrypto.ecdh(key, peer: pkA) else { return fail("bad_message", "ECDH failed") }
        let trust = PBCrypto.trustKey(shared: shared, transcript: tr)
        let keys = PBCrypto.sessionKeys(shared: shared, trustKey: SymmetricKey(data: trust), na: na, nb: nb, transcript: tr)
        let code = PBCrypto.sas(transcript: tr)
        state = .pairAwaitConfirm(PairContext(device: device, name: name, transcript: tr, trust: trust, keys: keys))
        pendingCode = code

        var out = HandshakeMessage(t: "pair_reveal")
        out.n = nb.base64EncodedString()
        delegate?.handshake(self, send: out.payload())
        delegate?.handshake(self, requestApprovalFor: code, deviceName: name)
    }

    private func finishPairingIfReady() {
        guard case let .pairAwaitConfirm(ctx) = state, ctx.approved == true, let mac = ctx.confirmMAC else { return }
        let trustKey = SymmetricKey(data: ctx.trust)
        guard PBCrypto.verifyConfirm(trustKey: trustKey, role: "C", transcript: ctx.transcript, mac: mac) else {
            return fail("bad_confirm", "Key confirmation failed")
        }
        let device = TrustedDevice(id: ctx.device.base64EncodedString(), name: ctx.name, key: ctx.trust)
        var out = HandshakeMessage(t: "pair_ok")
        out.mac = PBCrypto.confirmMAC(trustKey: trustKey, role: "P", transcript: ctx.transcript).base64EncodedString()
        out.phoneId = phoneId.base64EncodedString()
        state = .done
        pendingCode = nil
        delegate?.handshake(self, send: out.payload())
        delegate?.handshake(self, completed: device,
                            channel: SecureChannel(sendKey: ctx.keys.p2c, recvKey: ctx.keys.c2p),
                            newlyPaired: true)
    }

    // MARK: - Resume

    private func resumeHello(_ m: HandshakeMessage) {
        guard let delegate else { return }
        guard let deviceRaw = m.device.flatMap({ Data(base64Encoded: $0) }), deviceRaw.count == 16,
              let pkA = m.pk.flatMap({ Data(base64Encoded: $0) }), pkA.count == 65,
              let na = m.n.flatMap({ Data(base64Encoded: $0) }), na.count == 16 else {
            return fail("bad_message", "Invalid resume_hello")
        }
        guard let device = delegate.handshake(self, trustedDeviceFor: deviceRaw.base64EncodedString()) else {
            return fail("unknown_device", "This Chromebook is not trusted by the iPhone. Pair it again.")
        }
        let key = P256.KeyAgreement.PrivateKey()
        let pkB = key.publicKey.x963Representation
        let nb = PBCrypto.randomBytes(16)
        let tr = PBCrypto.transcript(label: "PB-resume-v1", device: deviceRaw, pkA: pkA, pkB: pkB, na: na, nb: nb)
        guard let shared = try? PBCrypto.ecdh(key, peer: pkA) else { return fail("bad_message", "ECDH failed") }
        let trustKey = SymmetricKey(data: device.key)
        let keys = PBCrypto.sessionKeys(shared: shared, trustKey: trustKey, na: na, nb: nb, transcript: tr)
        state = .resumeAwaitProof(device: device, transcript: tr, keys: keys)

        var out = HandshakeMessage(t: "resume_challenge")
        out.pk = pkB.base64EncodedString()
        out.n = nb.base64EncodedString()
        out.mac = PBCrypto.confirmMAC(trustKey: trustKey, role: "P", transcript: tr).base64EncodedString()
        delegate.handshake(self, send: out.payload())
    }

    private func resumeProof(_ m: HandshakeMessage, device: TrustedDevice, transcript: Data, keys: SessionKeys) {
        guard let mac = m.mac.flatMap({ Data(base64Encoded: $0) }),
              PBCrypto.verifyConfirm(trustKey: SymmetricKey(data: device.key), role: "C", transcript: transcript, mac: mac) else {
            return fail("bad_proof", "Chromebook failed authentication")
        }
        state = .done
        delegate?.handshake(self, send: HandshakeMessage(t: "resume_ok").payload())
        delegate?.handshake(self, completed: device, channel: SecureChannel(sendKey: keys.p2c, recvKey: keys.c2p),
                            newlyPaired: false)
    }

    // MARK: -

    private func fail(_ code: String, _ message: String, notifyPeer: Bool = true, countsAsPairingFailure: Bool = true) {
        let pairing = isPairing && countsAsPairingFailure
        state = .failed
        pendingCode = nil
        if notifyPeer { delegate?.handshake(self, send: HandshakeMessage.error(code, message).payload()) }
        delegate?.handshake(self, failed: code, message: message, duringPairing: pairing)
    }
}
