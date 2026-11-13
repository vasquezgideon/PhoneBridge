import XCTest
import CryptoKit
@testable import PhoneBridgeCore

/// Drives PhoneHandshake with a scripted Chromebook built from the same primitives.
final class HandshakeTests: XCTestCase {
    final class Recorder: PhoneHandshakeDelegate {
        let G: Data
        var sent: [HandshakeMessage] = []
        var completed: (ClientInfo, SecureChannel)?
        var failure: String?
        init(password: String) { G = PBCrypto.generator(password: password) }
        func handshakeGenerator(_ h: PhoneHandshake) -> Data { G }
        func handshake(_ h: PhoneHandshake, send payload: Data) { sent.append(HandshakeMessage.decode(payload)!) }
        func handshake(_ h: PhoneHandshake, completed client: ClientInfo, channel: SecureChannel) { completed = (client, channel) }
        func handshake(_ h: PhoneHandshake, failed code: String, message: String) { failure = code }
    }

    func b64(_ s: String?) -> Data { Data(base64Encoded: s ?? "")! }

    /// One attempt. Returns (recorder, client channel if it succeeded, client saw valid phone MAC).
    func attempt(phonePassword: String, clientPassword: String, limiter: AttemptLimiter = AttemptLimiter(),
                 sendProofAnyway: Bool = false) throws -> (Recorder, SecureChannel?, Bool) {
        let rec = Recorder(password: phonePassword)
        let h = PhoneHandshake(phoneName: "Test iPhone", limiter: limiter)
        h.delegate = rec
        let G = PBCrypto.generator(password: clientPassword)
        let a = Curve25519.KeyAgreement.PrivateKey()
        let ya = try PBCrypto.x25519(a, G)
        let device = PBCrypto.randomBytes(16), na = PBCrypto.randomBytes(16)
        var hello = HandshakeMessage(t: "hello")
        hello.v = 2; hello.device = device.base64EncodedString(); hello.name = "CB"
        hello.pk = ya.base64EncodedString(); hello.n = na.base64EncodedString()
        h.receive(hello.payload())

        let ch = try XCTUnwrap(rec.sent.last)
        guard ch.t == "challenge" else { return (rec, nil, false) }
        XCTAssertEqual(ch.phone, "Test iPhone")
        let yb = b64(ch.pk), nb = b64(ch.n)
        let tr = PBCrypto.transcript(device: device, ya: ya, yb: yb, na: na, nb: nb)
        let keys = PBCrypto.deriveKeys(shared: try PBCrypto.x25519(a, yb), transcript: tr)
        let phoneOK = PBCrypto.verifyP(keys, tr, b64(ch.mac))
        guard phoneOK || sendProofAnyway else { return (rec, nil, false) }

        var proof = HandshakeMessage(t: "proof")
        proof.mac = PBCrypto.macC(keys, tr).base64EncodedString()
        h.receive(proof.payload())
        guard rec.sent.last?.t == "ok" else { return (rec, nil, phoneOK) }
        return (rec, SecureChannel(sendKey: keys.c2p, recvKey: keys.p2c), phoneOK)
    }

    func testRightPassword() throws {
        let (rec, client, phoneOK) = try attempt(phonePassword: "k7mq-3xph", clientPassword: "k7mq-3xph")
        XCTAssertTrue(phoneOK)
        let channel = try XCTUnwrap(client)
        let phone = try XCTUnwrap(rec.completed?.1)
        XCTAssertEqual(rec.completed?.0.name, "CB")
        let sealed = try channel.seal(ControlMessage.encode(["t": "ping", "id": 3]))
        XCTAssertEqual(ControlMessage.decode(try phone.open(sealed))?["id"] as? Int, 3)
        let back = try phone.seal(TunnelFrame(op: .data, stream: 9, payload: Data("x".utf8)).encoded())
        XCTAssertEqual(TunnelFrame(decoding: try channel.open(back))?.stream, 9)
        XCTAssertThrowsError(try channel.open(back), "replay must fail")
    }

    func testWrongPasswordDetectedByBothSides() throws {
        let (rec, client, phoneOK) = try attempt(phonePassword: "right", clientPassword: "wrong", sendProofAnyway: true)
        XCTAssertFalse(phoneOK, "client sees the phone MAC fail")
        XCTAssertNil(client)
        XCTAssertNil(rec.completed)
        XCTAssertEqual(rec.failure, "wrong_password")
        XCTAssertEqual(rec.sent.last?.code, "wrong_password")
    }

    func testUnprovenHellosLockOut() throws {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let limiter = AttemptLimiter(freeAttempts: 5, now: { clock })
        for _ in 0..<5 {
            let (rec, _, _) = try attempt(phonePassword: "right", clientPassword: "guess", limiter: limiter)
            XCTAssertEqual(rec.sent.last?.t, "challenge")
        }
        let (locked, _, _) = try attempt(phonePassword: "right", clientPassword: "right", limiter: limiter)
        XCTAssertEqual(locked.sent.last?.code, "locked_out")
        XCTAssertEqual(locked.sent.last?.lockoutSeconds, 30)
        clock = clock.addingTimeInterval(31)
        let (_, ok, _) = try attempt(phonePassword: "right", clientPassword: "right", limiter: limiter)
        XCTAssertNotNil(ok, "allowed again after the lockout")
        XCTAssertEqual(limiter.unproven, 0, "success resets the counter")
    }

    func testMalformedHello() {
        let rec = Recorder(password: "x")
        let h = PhoneHandshake(phoneName: "P", limiter: AttemptLimiter())
        h.delegate = rec
        var hello = HandshakeMessage(t: "hello")
        hello.device = "AAAA"
        h.receive(hello.payload())
        XCTAssertEqual(rec.sent.last?.code, "bad_message")
    }
}

final class FieldTests: XCTestCase {
    func fe(_ hex: String) -> FieldElement { FieldElement(bytesLE: Data(hexString: hex)!) }

    func testReductionEdges() {
        // p, p+1, 2^256−1 reduce correctly.
        XCTAssertTrue(fe("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f").isZero)
        XCTAssertEqual(fe("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"), .one)
        XCTAssertEqual(fe(String(repeating: "ff", count: 32)).bytesLE.hexString,
                       "2500000000000000000000000000000000000000000000000000000000000000")
    }

    func testInverseAndNegation() {
        let x = FieldElement(small: 5)
        XCTAssertEqual(x * x.inverse, .one)
        XCTAssertTrue((x + (-x)).isZero)
        XCTAssertTrue((-FieldElement.zero).isZero)
        XCTAssertEqual(FieldElement(small: 3) - FieldElement(small: 5) + FieldElement(small: 2), .zero)
    }
}

final class WireTests: XCTestCase {
    func testFrameAssemblerSplits() throws {
        let payloads = [Data(), PBCrypto.randomBytes(1), PBCrypto.randomBytes(500), PBCrypto.randomBytes(9000)]
        var stream = Data()
        payloads.forEach { stream.append(FrameAssembler.frame($0)) }
        var asm = FrameAssembler()
        var out: [Data] = []
        var i = 0
        while i < stream.count {
            let n = min(Int.random(in: 1...257), stream.count - i)
            out += try asm.append(stream.subdata(in: i..<(i + n)))
            i += n
        }
        XCTAssertEqual(out, payloads)
    }

    func testOversizedFrame() {
        var asm = FrameAssembler(maxFrame: 100)
        XCTAssertThrowsError(try asm.append(Data([0, 0, 1, 0])))
    }

    func testTunnelFrame() {
        let c = TunnelFrame(op: .data, stream: 0xabcdef01, payload: Data([9, 8, 7]))
        XCTAssertEqual(TunnelFrame(decoding: c.encoded()), c)
        XCTAssertNil(TunnelFrame(decoding: Data([4, 9, 0, 0, 0, 1])), "unknown op")
        XCTAssertNil(TunnelFrame(op: .connect, stream: 1, payload: Data([0, 0, 0x61])).connectTarget, "port 0")
    }
}
