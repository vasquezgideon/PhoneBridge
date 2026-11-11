import XCTest
import CryptoKit
@testable import PhoneBridgeCore

/// Drives PhoneHandshake with a scripted Chromebook built from the same primitives.
final class HandshakeTests: XCTestCase {
    final class Recorder: PhoneHandshakeDelegate {
        var trusted: [String: TrustedDevice] = [:]
        var pairingOpen = true
        var sent: [HandshakeMessage] = []
        var approvalCode: String?
        var completed: (TrustedDevice, SecureChannel, Bool)?
        var failure: (String, Bool)?

        func handshake(_ h: PhoneHandshake, trustedDeviceFor id: String) -> TrustedDevice? { trusted[id] }
        func handshakePairingAllowed(_ h: PhoneHandshake) -> Bool { pairingOpen }
        func handshake(_ h: PhoneHandshake, requestApprovalFor code: String, deviceName: String) { approvalCode = code }
        func handshake(_ h: PhoneHandshake, send payload: Data) { sent.append(HandshakeMessage.decode(payload)!) }
        func handshake(_ h: PhoneHandshake, completed device: TrustedDevice, channel: SecureChannel, newlyPaired: Bool) {
            completed = (device, channel, newlyPaired)
        }
        func handshake(_ h: PhoneHandshake, failed code: String, message: String, duringPairing: Bool) {
            failure = (code, duringPairing)
        }
    }

    func b64(_ s: String?) -> Data { Data(base64Encoded: s ?? "")! }

    /// Runs a full pairing; returns (recorder, deviceId, trust, client channel).
    func pair(approve: Bool = true, tamperMAC: Bool = false) -> (Recorder, Data, Data?, SecureChannel?) {
        let rec = Recorder()
        let h = PhoneHandshake(phoneName: "Test iPhone", phoneId: Data(repeating: 7, count: 16))
        h.delegate = rec
        let device = PBCrypto.randomBytes(16)
        let a = P256.KeyAgreement.PrivateKey()
        let pkA = a.publicKey.x963Representation

        var hello = HandshakeMessage(t: "pair_hello")
        hello.v = 1; hello.device = device.base64EncodedString(); hello.name = "CB"; hello.pk = pkA.base64EncodedString()
        h.receive(hello.payload())
        let commitMsg = rec.sent.last!
        XCTAssertEqual(commitMsg.t, "pair_commit")
        XCTAssertEqual(commitMsg.phone, "Test iPhone")
        let pkB = b64(commitMsg.pk)

        let na = PBCrypto.randomBytes(16)
        var nonce = HandshakeMessage(t: "pair_nonce"); nonce.n = na.base64EncodedString()
        h.receive(nonce.payload())
        let reveal = rec.sent.last!
        XCTAssertEqual(reveal.t, "pair_reveal")
        let nb = b64(reveal.n)
        XCTAssertEqual(PBCrypto.commit(device: device, pkA: pkA, pkB: pkB, nb: nb), b64(commitMsg.commit))

        let tr = PBCrypto.transcript(label: "PB-pair-v1", device: device, pkA: pkA, pkB: pkB, na: na, nb: nb)
        XCTAssertEqual(rec.approvalCode, PBCrypto.sas(transcript: tr))
        let shared = try! PBCrypto.ecdh(a, peer: pkB)
        let trust = PBCrypto.trustKey(shared: shared, transcript: tr)
        let tk = SymmetricKey(data: trust)
        var mac = PBCrypto.confirmMAC(trustKey: tk, role: "C", transcript: tr)
        if tamperMAC { mac[mac.startIndex] ^= 1 }

        var confirm = HandshakeMessage(t: "pair_confirm"); confirm.mac = mac.base64EncodedString()
        h.receive(confirm.payload())
        XCTAssertNil(rec.completed, "must wait for the on-phone approval")
        h.approve(approve)
        guard let done = rec.completed else { return (rec, device, nil, nil) }

        let ok = rec.sent.last!
        XCTAssertEqual(ok.t, "pair_ok")
        XCTAssertTrue(PBCrypto.verifyConfirm(trustKey: tk, role: "P", transcript: tr, mac: b64(ok.mac)))
        XCTAssertEqual(done.0.key, trust)
        XCTAssertTrue(done.2)
        let keys = PBCrypto.sessionKeys(shared: shared, trustKey: tk, na: na, nb: nb, transcript: tr)
        return (rec, device, trust, SecureChannel(sendKey: keys.c2p, recvKey: keys.p2c))
    }

    func testPairingRoundTrip() throws {
        let (rec, _, _, client) = pair()
        let phone = rec.completed!.1
        let sealed = try client!.seal(ControlMessage.encode(["t": "ping", "id": 3]))
        XCTAssertEqual(ControlMessage.decode(try phone.open(sealed))?["id"] as? Int, 3)
        let back = try phone.seal(ControlMessage.encode(["t": "pong"]))
        XCTAssertEqual(ControlMessage.decode(try client!.open(back))?["t"] as? String, "pong")
        XCTAssertThrowsError(try client!.open(back), "replay must fail")
    }

    func testRejectedPairing() {
        let (rec, _, trust, _) = pair(approve: false)
        XCTAssertNil(trust)
        XCTAssertEqual(rec.failure?.0, "rejected")
        XCTAssertEqual(rec.failure?.1, true)
        XCTAssertEqual(rec.sent.last?.code, "rejected")
    }

    func testBadConfirmation() {
        let (rec, _, trust, _) = pair(tamperMAC: true)
        XCTAssertNil(trust)
        XCTAssertEqual(rec.failure?.0, "bad_confirm")
    }

    func testPairingClosed() {
        let rec = Recorder(); rec.pairingOpen = false
        let h = PhoneHandshake(phoneName: "P", phoneId: Data(count: 16)); h.delegate = rec
        var hello = HandshakeMessage(t: "pair_hello")
        hello.device = Data(count: 16).base64EncodedString()
        hello.pk = P256.KeyAgreement.PrivateKey().publicKey.x963Representation.base64EncodedString()
        h.receive(hello.payload())
        XCTAssertEqual(rec.sent.last?.code, "pairing_closed")
        XCTAssertEqual(rec.failure?.1, false)
    }

    func testResume() throws {
        let (first, device, trust, _) = pair()
        let rec = Recorder()
        rec.trusted = [device.base64EncodedString(): first.completed!.0]
        let h = PhoneHandshake(phoneName: "P", phoneId: Data(count: 16)); h.delegate = rec

        let a = P256.KeyAgreement.PrivateKey(); let pkA = a.publicKey.x963Representation
        let na = PBCrypto.randomBytes(16)
        var hello = HandshakeMessage(t: "resume_hello")
        hello.device = device.base64EncodedString(); hello.pk = pkA.base64EncodedString(); hello.n = na.base64EncodedString()
        h.receive(hello.payload())
        let ch = rec.sent.last!
        XCTAssertEqual(ch.t, "resume_challenge")
        let pkB = b64(ch.pk), nb = b64(ch.n)
        let tr = PBCrypto.transcript(label: "PB-resume-v1", device: device, pkA: pkA, pkB: pkB, na: na, nb: nb)
        let tk = SymmetricKey(data: trust!)
        XCTAssertTrue(PBCrypto.verifyConfirm(trustKey: tk, role: "P", transcript: tr, mac: b64(ch.mac)))

        var proof = HandshakeMessage(t: "resume_proof")
        proof.mac = PBCrypto.confirmMAC(trustKey: tk, role: "C", transcript: tr).base64EncodedString()
        h.receive(proof.payload())
        XCTAssertEqual(rec.sent.last?.t, "resume_ok")
        XCTAssertEqual(rec.completed?.2, false)

        let keys = PBCrypto.sessionKeys(shared: try PBCrypto.ecdh(a, peer: pkB), trustKey: tk, na: na, nb: nb, transcript: tr)
        let client = SecureChannel(sendKey: keys.c2p, recvKey: keys.p2c)
        XCTAssertEqual(ControlMessage.decode(try rec.completed!.1.open(try client.seal(ControlMessage.encode(["t": "x"]))))?["t"] as? String, "x")
    }

    func testResumeUnknownDevice() {
        let rec = Recorder()
        let h = PhoneHandshake(phoneName: "P", phoneId: Data(count: 16)); h.delegate = rec
        var hello = HandshakeMessage(t: "resume_hello")
        hello.device = PBCrypto.randomBytes(16).base64EncodedString()
        hello.pk = P256.KeyAgreement.PrivateKey().publicKey.x963Representation.base64EncodedString()
        hello.n = PBCrypto.randomBytes(16).base64EncodedString()
        h.receive(hello.payload())
        XCTAssertEqual(rec.sent.last?.code, "unknown_device")
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

    func testTileHeader() {
        let t = TileHeader(frameId: 0xdeadbeef, fullWidth: 1280, fullHeight: 800, x: 1152, y: 768, width: 128, height: 32, flags: 1)
        let d = t.encode(jpeg: Data([1, 2, 3]))
        XCTAssertEqual(d.count, TileHeader.size + 3)
        XCTAssertEqual(d.readBE(UInt32.self, at: 1), 0xdeadbeef)
        XCTAssertEqual(d.readBE(UInt16.self, at: 9), 1152)
        XCTAssertEqual(d[17], 1)
    }

    func testPasswordVerifier() {
        let v = PasswordVerifier.make(password: "correct horse", iterations: 1000)
        XCTAssertTrue(v.verify("correct horse"))
        XCTAssertFalse(v.verify("correct horsf"))
        // RFC 7914 §11 PBKDF2-HMAC-SHA256 vector (P="passwd", S="salt", c=1, dkLen=64), first 32 bytes.
        XCTAssertEqual(PasswordVerifier.pbkdf2(password: "passwd", salt: Data("salt".utf8), iterations: 1).hexString,
                       "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc")
    }
}
