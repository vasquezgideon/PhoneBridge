import Foundation

/// Wire constants. Mirrors chromebook/src/protocol.js and protocol/packet-format.md.
public enum PBWire {
    public static let protocolVersion = 1
    public static let serviceUUID = "6E5A0001-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let rxUUID = "6E5A0002-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let txUUID = "6E5A0003-8F3C-4B7E-9A21-3D5C7B1E0A01"
    public static let maxFrame = 4 * 1024 * 1024

    public enum Outer: UInt8 { case handshake = 0x01, secure = 0x02 }
    public enum Inner: UInt8 { case control = 0x01, tile = 0x02, bench = 0x03 }
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

/// Display tile header (inner type 0x02).
public struct TileHeader: Equatable {
    public static let size = 18
    public static let endOfFrame: UInt8 = 1
    public static let keyframe: UInt8 = 2

    public var frameId: UInt32
    public var fullWidth: UInt16, fullHeight: UInt16
    public var x: UInt16, y: UInt16, width: UInt16, height: UInt16
    public var flags: UInt8

    public init(frameId: UInt32, fullWidth: UInt16, fullHeight: UInt16, x: UInt16, y: UInt16,
                width: UInt16, height: UInt16, flags: UInt8) {
        self.frameId = frameId; self.fullWidth = fullWidth; self.fullHeight = fullHeight
        self.x = x; self.y = y; self.width = width; self.height = height; self.flags = flags
    }

    public func encode(jpeg: Data) -> Data {
        var d = Data(capacity: Self.size + jpeg.count)
        d.append(PBWire.Inner.tile.rawValue)
        d.appendBE(frameId)
        d.appendBE(fullWidth); d.appendBE(fullHeight)
        d.appendBE(x); d.appendBE(y); d.appendBE(width); d.appendBE(height)
        d.append(flags)
        d.append(jpeg)
        return d
    }
}
