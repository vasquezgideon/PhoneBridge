import XCTest
import CryptoKit
@testable import PhoneBridgeCore

/// Checks the Swift implementation against protocol/test-vectors/handshake-v2.json,
/// which the JS client and protocol/xcheck.py also check.
final class VectorTests: XCTestCase {
    struct MapCase: Decodable { let r: String; let u: String }
    struct GenCase: Decodable { let password: String; let G: String }
    struct Handshake: Decodable {
        let password, G, device, ya, yb, Ya, Yb, na, nb, K, transcript, okm, macP, macC: String
    }
    struct Secure: Decodable { let c2pPlain, c2pPayload, p2cPlain, p2cPayload, c2pFramed: String }
    struct TunnelCase: Decodable { let op: String; let frame: String }
    struct Vectors: Decodable {
        let elligator2: [MapCase]
        let generators: [GenCase]
        let handshake: Handshake
        let secure: Secure
        let tunnel: [TunnelCase]
    }

    static func loadVectors() throws -> Vectors {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        url.appendPathComponent("protocol/test-vectors/handshake-v2.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func h(_ s: String) -> Data { Data(hexString: s)! }

    func testElligatorAndGenerators() throws {
        let v = try Self.loadVectors()
        for c in v.elligator2 {
            XCTAssertEqual(FieldElement.elligator2(FieldElement(bytesLE: h(c.r))).bytesLE.hexString, c.u, "r=\(c.r)")
        }
        for g in v.generators {
            XCTAssertEqual(PBCrypto.generator(password: g.password).hexString, g.G, g.password)
        }
    }

    func testHandshakeKeysAndChannelMatchJS() throws {
        let v = try Self.loadVectors()
        let hs = v.handshake
        let G = PBCrypto.generator(password: hs.password)
        XCTAssertEqual(G.hexString, hs.G)
        let a = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: h(hs.ya))
        let b = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: h(hs.yb))
        let ya = try PBCrypto.x25519(a, G), yb = try PBCrypto.x25519(b, G)
        XCTAssertEqual(ya.hexString, hs.Ya)
        XCTAssertEqual(yb.hexString, hs.Yb)
        let k = try PBCrypto.x25519(b, ya)
        XCTAssertEqual(k.hexString, hs.K)
        XCTAssertEqual(try PBCrypto.x25519(a, yb), k)

        let tr = PBCrypto.transcript(device: h(hs.device), ya: ya, yb: yb, na: h(hs.na), nb: h(hs.nb))
        XCTAssertEqual(tr.hexString, hs.transcript)
        let keys = PBCrypto.deriveKeys(shared: k, transcript: tr)
        XCTAssertEqual(keys.okm.hexString, hs.okm)
        XCTAssertEqual(PBCrypto.macP(keys, tr).hexString, hs.macP)
        XCTAssertEqual(PBCrypto.macC(keys, tr).hexString, hs.macC)
        XCTAssertTrue(PBCrypto.verifyC(keys, tr, h(hs.macC)))
        XCTAssertFalse(PBCrypto.verifyC(keys, tr, h(hs.macP)))

        let phone = SecureChannel(sendKey: keys.p2c, recvKey: keys.c2p)
        XCTAssertEqual(try phone.open(h(v.secure.c2pPayload)).hexString, v.secure.c2pPlain)
        XCTAssertEqual(try phone.seal(h(v.secure.p2cPlain)).hexString, v.secure.p2cPayload)
        XCTAssertEqual(FrameAssembler.frame(h(v.secure.c2pPayload)).hexString, v.secure.c2pFramed)
        let frame = TunnelFrame(decoding: h(v.secure.p2cPlain))
        XCTAssertEqual(frame?.op, .data)
        XCTAssertEqual(frame?.stream, 7)
        XCTAssertEqual(frame.map { String(decoding: $0.payload, as: UTF8.self) }, "hello body")
    }

    func testTunnelFramesMatchJS() throws {
        let v = try Self.loadVectors()
        let expected: [String: TunnelFrame] = [
            "CONNECT": .connect(1, host: "example.com", port: 443),
            "OPENED": TunnelFrame(op: .opened, stream: 1),
            "DATA": TunnelFrame(op: .data, stream: 0xabcdef01, payload: Data([0x16, 0x03, 0x01])),
            "CLOSE": .close(2, .dns),
        ]
        for c in v.tunnel {
            let want = try XCTUnwrap(expected[c.op])
            XCTAssertEqual(want.encoded().hexString, c.frame, c.op)
            XCTAssertEqual(TunnelFrame(decoding: h(c.frame)), want, c.op)
        }
        let target = try XCTUnwrap(TunnelFrame.connect(9, host: "bücher.example", port: 8443).connectTarget)
        XCTAssertEqual(target.host, "bücher.example")
        XCTAssertEqual(target.port, 8443)
    }
}
