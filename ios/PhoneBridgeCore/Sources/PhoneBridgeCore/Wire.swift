import Foundation

/// Wire constants. Mirrors chromebook/src/protocol.js and protocol/packet-format.md.
public enum PBWire {
    public static let protocolVersion = 3
    public static let serviceUUID = "6E5A0001-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let rxUUID = "6E5A0002-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let txUUID = "6E5A0003-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let maxFrame = 4 * 1024 * 1024

    public enum Outer: UInt8 { case handshake = 0x01, secure = 0x02 }
    public enum Inner: UInt8 { case control = 0x01, bench = 0x03, tunnel = 0x04 }
}

public extension Data {
    mutating func appendBE<T: FixedWidthInteger>(_ value: T) {
        var be = value.bigEndian
        Swift.withUnsafeBytes(of: &be) { append(contentsOf: $0) }
    }

    /// Reads a big-endian integer at a zero-based offset (slice-safe).
    func readBE<T: FixedWidthInteger>(_ type: T.Type, at offset: Int) -> T? {
        let size = MemoryLayout<T>.size
        guard offset >= 0, offset + size <= count else { return nil }
        var v: T = 0
        for i in 0..<size { v = (v << 8) | T(self[startIndex + offset + i]) }
        return v
    }

    var hexString: String { map { String(format: "%02x", $0) }.joined() }

    init?(hexString: String) {
        guard hexString.count % 2 == 0 else { return nil }
        var out = Data(capacity: hexString.count / 2)
        var it = hexString.makeIterator()
        while let a = it.next(), let b = it.next() {
            guard let byte = UInt8(String([a, b]), radix: 16) else { return nil }
            out.append(byte)
        }
        self = out
    }
}

/// Splits a byte stream into `u32 BE length | payload` frames.
public struct FrameAssembler {
    public enum Failure: Error { case frameTooLarge(Int) }
    private var buffer = Data()
    public let maxFrame: Int

    public init(maxFrame: Int = PBWire.maxFrame) { self.maxFrame = maxFrame }

    public mutating func reset() { buffer = Data() }

    public mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var frames: [Data] = []
        var cursor = 0
        while buffer.count - cursor >= 4 {
            let len = Int(buffer.readBE(UInt32.self, at: cursor)!)
            guard len <= maxFrame else { reset(); throw Failure.frameTooLarge(len) }
            guard buffer.count - cursor - 4 >= len else { break }
            let start = buffer.startIndex + cursor + 4
            frames.append(Data(buffer[start..<(start + len)]))
            cursor += 4 + len
        }
        if cursor > 0 { buffer = Data(buffer.suffix(from: buffer.startIndex + cursor)) }
        return frames
    }

    public static func frame(_ payload: Data) -> Data {
        var d = Data(capacity: payload.count + 4)
        d.appendBE(UInt32(payload.count))
        d.append(payload)
        return d
    }
}

/// Inner control messages: 0x01 + JSON object.
public enum ControlMessage {
    public static func encode(_ object: [String: Any]) -> Data {
        var d = Data([PBWire.Inner.control.rawValue])
        d.append((try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
        return d
    }

    public static func decode(_ inner: Data) -> [String: Any]? {
        guard inner.first == PBWire.Inner.control.rawValue else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(inner.dropFirst()))) as? [String: Any]
    }
}

/// Tunnel frame (inner type 0x04): 0x04 | u8 op | u32 stream | payload.
/// The iPhone only ever handles raw TCP bytes; TLS and HTTP live on the Chromebook.
public struct TunnelFrame: Equatable {
    public enum Op: UInt8 { case connect = 0x01, opened = 0x02, data = 0x03, close = 0x04 }
    public enum Reason: UInt8 { case normal = 0, reset = 1, refused = 2, dns = 3, timeout = 4, unreachable = 5, limit = 6, bad = 7 }
    public static let headerSize = 6

    public var op: Op
    public var stream: UInt32
    public var payload: Data

    public init(op: Op, stream: UInt32, payload: Data = Data()) {
        self.op = op; self.stream = stream; self.payload = payload
    }

    public static func close(_ stream: UInt32, _ reason: Reason) -> TunnelFrame {
        TunnelFrame(op: .close, stream: stream, payload: Data([reason.rawValue]))
    }

    public func encoded() -> Data {
        var d = Data(capacity: Self.headerSize + payload.count)
        d.append(PBWire.Inner.tunnel.rawValue)
        d.append(op.rawValue)
        d.appendBE(stream)
        d.append(payload)
        return d
    }

    public init?(decoding inner: Data) {
        let p = Data(inner)
        guard p.count >= Self.headerSize, p[0] == PBWire.Inner.tunnel.rawValue,
              let op = Op(rawValue: p[1]), let stream = p.readBE(UInt32.self, at: 2) else { return nil }
        self.op = op
        self.stream = stream
        self.payload = p.subdata(in: Self.headerSize..<p.count)
    }

    /// CONNECT payload: u16 port | UTF-8 host.
    public var connectTarget: (host: String, port: UInt16)? {
        guard op == .connect, payload.count >= 3, let port = payload.readBE(UInt16.self, at: 0), port > 0,
              let host = String(data: payload.subdata(in: 2..<payload.count), encoding: .utf8), !host.isEmpty else { return nil }
        return (host, port)
    }

    public static func connect(_ stream: UInt32, host: String, port: UInt16) -> TunnelFrame {
        var p = Data()
        p.appendBE(port)
        p.append(Data(host.utf8))
        return TunnelFrame(op: .connect, stream: stream, payload: p)
    }
}
