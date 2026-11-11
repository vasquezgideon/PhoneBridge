import XCTest
import CryptoKit
@testable import PhoneBridgeCore

/// Checks the Swift implementation against protocol/test-vectors/handshake-v1.json,
/// which the JS client is also tested against.
final class VectorTests: XCTestCase {
    struct Section: Decodable {
        let device, dA, dB, pkA, pkB, na, nb, transcript, sas, shared, okm, macC, macP: String
        let commit: String?
        let trust: String?
    }
    struct Secure: Decodable { let c2pPlain, c2pPayload, p2cPlain, p2cPayload, c2pFramed: String }
    struct Vectors: Decodable { let pair: Section; let resume: Section; let secure: Secure }

    static func load() throws -> Vectors {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        url.appendPathComponent("protocol/test-vectors/handshake-v1.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func h(_ s: String) -> Data { Data(hexString: s)! }

    func check(_ s: Section, label: String, trust givenTrust: Data?) throws -> (trust: Data, keys: SessionKeys) {
        let a = try P256.KeyAgreement.PrivateKey(rawRepresentation: h(s.dA))
        let b = try P256.KeyAgreement.PrivateKey(rawRepresentation: h(s.dB))
        XCTAssertEqual(a.publicKey.x963Representation.hexString, s.pkA)
        XCTAssertEqual(b.publicKey.x963Representation.hexString, s.pkB)

        let tr = PBCrypto.transcript(label: label, device: h(s.device), pkA: h(s.pkA), pkB: h(s.pkB), na: h(s.na), nb: h(s.nb))
        XCTAssertEqual(tr.hexString, s.transcript)
        XCTAssertEqual(PBCrypto.sas(transcript: tr), s.sas)

        let shared = try PBCrypto.ecdh(b, peer: h(s.pkA))
        XCTAssertEqual(shared.hexString, s.shared)
        XCTAssertEqual(try PBCrypto.ecdh(a, peer: h(s.pkB)), shared)

        let trust: Data
        if let given = givenTrust {
            trust = given
        } else {
            XCTAssertEqual(PBCrypto.commit(device: h(s.device), pkA: h(s.pkA), pkB: h(s.pkB), nb: h(s.nb)).hexString, s.commit)
            trust = PBCrypto.trustKey(shared: shared, transcript: tr)
            XCTAssertEqual(trust.hexString, s.trust)
        }
        let tk = SymmetricKey(data: trust)
        let keys = PBCrypto.sessionKeys(shared: shared, trustKey: tk, na: h(s.na), nb: h(s.nb), transcript: tr)
        XCTAssertEqual(keys.okm.hexString, s.okm)
        XCTAssertEqual(PBCrypto.confirmMAC(trustKey: tk, role: "C", transcript: tr).hexString, s.macC)
        XCTAssertEqual(PBCrypto.confirmMAC(trustKey: tk, role: "P", transcript: tr).hexString, s.macP)
        XCTAssertTrue(PBCrypto.verifyConfirm(trustKey: tk, role: "C", transcript: tr, mac: h(s.macC)))
        XCTAssertFalse(PBCrypto.verifyConfirm(trustKey: tk, role: "C", transcript: tr, mac: h(s.macP)))
        return (trust, keys)
    }

    func testPairResumeAndSecureChannelMatchJS() throws {
        let v = try Self.load()
        let pair = try check(v.pair, label: "PB-pair-v1", trust: nil)
        _ = try check(v.resume, label: "PB-resume-v1", trust: pair.trust)

        // Phone side: receives with c2p, sends with p2c.
        let phone = SecureChannel(sendKey: pair.keys.p2c, recvKey: pair.keys.c2p)
        XCTAssertEqual(try phone.open(h(v.secure.c2pPayload)).hexString, v.secure.c2pPlain)
        XCTAssertEqual(try phone.seal(h(v.secure.p2cPlain)).hexString, v.secure.p2cPayload)
        XCTAssertEqual(FrameAssembler.frame(h(v.secure.c2pPayload)).hexString, v.secure.c2pFramed)

        let msg = ControlMessage.decode(h(v.secure.c2pPlain))
        XCTAssertEqual(msg?["t"] as? String, "ping")
    }
}
