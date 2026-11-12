import Foundation
import CryptoKit

/// Handshake JSON (outer type 0x01). Unused fields are omitted when encoding.
public struct HandshakeMessage: Codable, Equatable {
    public var t: String
    public var v: Int?
    public var device: String?
    public var name: String?
    public var pk: String?
    public var n: String?
    public var mac: String?
    public var phone: String?
    public var code: String?
    public var msg: String?
    public var lockoutSeconds: Int?

    public init(t: String) { self.t = t }

    public static func error(_ code: String, _ msg: String, lockout: Int? = nil) -> HandshakeMessage {
        var m = HandshakeMessage(t: "error"); m.code = code; m.msg = msg; m.lockoutSeconds = lockout; return m
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

/// Online-guessing limit. Every `hello` counts as an attempt until a valid proof clears it, so a
/// client that checks the phone's MAC and walks away still uses up a guess.
public final class AttemptLimiter {
    public let freeAttempts: Int
    private let now: () -> Date
    private(set) public var unproven = 0
    private var lockouts = 0
    private var lockedUntil = Date.distantPast

    public init(freeAttempts: Int = 5, now: @escaping () -> Date = Date.init) {
        self.freeAttempts = freeAttempts
        self.now = now
    }

    /// nil = go ahead; otherwise seconds until the next attempt is allowed.
    /// After `freeAttempts` unproven hellos: lock 30 s, then one more try, then 60 s, … capped at 15 min.
    public func begin() -> TimeInterval? {
        let t = now()
        if t < lockedUntil { return lockedUntil.timeIntervalSince(t) }
        if unproven >= freeAttempts {
            lockouts += 1
            let secs = min(30 * pow(2, Double(lockouts - 1)), 900)
            lockedUntil = t.addingTimeInterval(secs)
            unproven = freeAttempts - 1
            return secs
        }
        unproven += 1
        return nil
    }

    public func succeeded() {
        unproven = 0
        lockouts = 0
        lockedUntil = .distantPast
    }

    public var lockoutRemaining: TimeInterval { max(0, lockedUntil.timeIntervalSince(now())) }
}

public struct ClientInfo: Equatable {
    public let deviceId: String
    public let name: String
}

public protocol PhoneHandshakeDelegate: AnyObject {
    /// Base point for the current password: PBCrypto.generator(password:).
    func handshakeGenerator(_ h: PhoneHandshake) -> Data
    func handshake(_ h: PhoneHandshake, send payload: Data)
    func handshake(_ h: PhoneHandshake, completed client: ClientInfo, channel: SecureChannel)
    func handshake(_ h: PhoneHandshake, failed code: String, message: String)
}

/// Phone side of the v2 handshake. One instance per attempt.
public final class PhoneHandshake {
    public weak var delegate: PhoneHandshakeDelegate?
    public let phoneName: String
    let limiter: AttemptLimiter

    private enum State {
        case idle
        case awaitProof(client: ClientInfo, transcript: Data, keys: PBCrypto.Keys)
        case done
        case failed
    }
    private var state: State = .idle

    public init(phoneName: String, limiter: AttemptLimiter) {
        self.phoneName = phoneName
        self.limiter = limiter
    }

    public var isComplete: Bool { if case .done = state { return true }; return false }
    public var isFinished: Bool {
        switch state {
        case .done, .failed: return true
        default: return false
        }
    }

    public func receive(_ payload: Data) {
        guard let m = HandshakeMessage.decode(payload) else { return fail("bad_message", "Malformed handshake message") }
        if m.t == "error" { return fail(m.code ?? "remote_error", m.msg ?? "Client cancelled", notifyPeer: false) }
        switch (m.t, state) {
        case ("hello", .idle): hello(m)
        case ("proof", let .awaitProof(client, transcript, keys)): proof(m, client: client, transcript: transcript, keys: keys)
        default: fail("bad_message", "Unexpected \(m.t)")
        }
    }

    public func cancel() {
        if !isFinished { state = .failed }
    }

    private func hello(_ m: HandshakeMessage) {
        guard let delegate else { return }
        guard let device = m.device.flatMap({ Data(base64Encoded: $0) }), device.count == 16,
              let ya = m.pk.flatMap({ Data(base64Encoded: $0) }), ya.count == 32,
              let na = m.n.flatMap({ Data(base64Encoded: $0) }), na.count == 16 else {
            return fail("bad_message", "Invalid hello")
        }
        if let wait = limiter.begin() {
            let secs = Int(wait.rounded(.up))
            return fail("locked_out", "Too many wrong attempts. Try again in \(secs) s.", lockout: secs)
        }
        let G = delegate.handshakeGenerator(self)
        let key = Curve25519.KeyAgreement.PrivateKey()
        guard let yb = try? PBCrypto.x25519(key, G), let k = try? PBCrypto.x25519(key, ya) else {
            return fail("bad_message", "Invalid key share")
        }
        let nb = PBCrypto.randomBytes(16)
        let tr = PBCrypto.transcript(device: device, ya: ya, yb: yb, na: na, nb: nb)
        let keys = PBCrypto.deriveKeys(shared: k, transcript: tr)
        let client = ClientInfo(deviceId: device.base64EncodedString(), name: String((m.name ?? "Chromebook").prefix(64)))
        state = .awaitProof(client: client, transcript: tr, keys: keys)

        var out = HandshakeMessage(t: "challenge")
        out.pk = yb.base64EncodedString()
        out.n = nb.base64EncodedString()
        out.mac = PBCrypto.macP(keys, tr).base64EncodedString()
        out.phone = phoneName
        delegate.handshake(self, send: out.payload())
    }

    private func proof(_ m: HandshakeMessage, client: ClientInfo, transcript: Data, keys: PBCrypto.Keys) {
        guard let mac = m.mac.flatMap({ Data(base64Encoded: $0) }), PBCrypto.verifyC(keys, transcript, mac) else {
            return fail("wrong_password", "Wrong password")
        }
        limiter.succeeded()
        state = .done
        delegate?.handshake(self, send: HandshakeMessage(t: "ok").payload())
        delegate?.handshake(self, completed: client, channel: SecureChannel(sendKey: keys.p2c, recvKey: keys.c2p))
    }

    private func fail(_ code: String, _ message: String, notifyPeer: Bool = true, lockout: Int? = nil) {
        state = .failed
        if notifyPeer { delegate?.handshake(self, send: HandshakeMessage.error(code, message, lockout: lockout).payload()) }
        delegate?.handshake(self, failed: code, message: message)
    }
}
