import Foundation
import Network
import PhoneBridgeCore

/// The iPhone's entire job: open TCP connections the Chromebook asks for and move bytes.
/// It never parses what flows through — HTTPS stays encrypted end-to-end between the Chromebook
/// and the website. The only things known here are host:port and byte counts.
///
/// Latency is the design goal. Bluetooth moves tens of kB/s, so any data queued ahead of a small
/// message (a TLS handshake on a new connection, a ping) delays it by seconds. So:
/// - the radio pulls frames (`nextFrame`) only when its own queue is nearly empty;
/// - frames carry at most 2 KB of data, so nothing waits behind a big one;
/// - OPENED / CLOSE go first, then the connection that has sent the least recently — a fresh
///   handshake beats a bulk download, and bulk downloads share fairly;
/// - early data: bytes for a connection that's still opening are held and sent once it's up, so
///   the Chromebook doesn't wait a round trip for OPENED before starting TLS.
final class TunnelServer {
    static let maxStreams = 256
    static let readSize = 16 * 1024
    static let frameData = 2048
    static let pauseAbove = 64 * 1024
    static let earlyLimit = 256 * 1024

    /// Called when there's something new to send; the owner then pulls with `nextFrame()`.
    var onReady: () -> Void = {}

    private(set) var bytesDown = 0     // internet → Chromebook
    private(set) var bytesUp = 0       // Chromebook → internet
    private(set) var totalOpened = 0
    var openCount: Int { streams.count }

    private final class Stream {
        let id: UInt32
        let connection: NWConnection
        var frames: [Data] = []
        var queued = 0
        var reading = false
        var paused = false
        var ready = false
        var finished = false
        var early: [Data] = []
        var earlyBytes = 0
        var recent: Double = 0
        var recentAt = CFAbsoluteTimeGetCurrent()
        init(id: UInt32, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    private var streams: [UInt32: Stream] = [:]
    private var urgent: [Data] = []

    func handle(_ f: TunnelFrame) {
        switch f.op {
        case .connect: open(f)
        case .data:
            guard let s = streams[f.stream] else { return }   // a half-closed connection still takes writes
            bytesUp += f.payload.count
            if s.ready {
                write(s, f.payload)
            } else {
                s.earlyBytes += f.payload.count
                if s.earlyBytes > Self.earlyLimit { return fail(s, .limit) }
                s.early.append(f.payload)
            }
        case .close:
            guard let s = streams[f.stream] else { return }
            remove(s)
            s.connection.cancel()
        case .opened:
            break
        }
    }

    func reset() {
        for s in streams.values { s.connection.cancel() }
        streams.removeAll()
        urgent.removeAll()
    }

    // MARK: - Connections

    private func open(_ f: TunnelFrame) {
        guard streams[f.stream] == nil else { return }
        guard let target = f.connectTarget, let port = NWEndpoint.Port(rawValue: target.port) else {
            return post(TunnelFrame.close(f.stream, .bad))
        }
        guard streams.count < Self.maxStreams else { return post(TunnelFrame.close(f.stream, .limit)) }

        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 20
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        let connection = NWConnection(host: NWEndpoint.Host(target.host), port: port, using: params)
        let s = Stream(id: f.stream, connection: connection)
        streams[f.stream] = s
        totalOpened += 1

        connection.stateUpdateHandler = { [weak self, weak s] state in
            guard let self, let s, self.streams[s.id] === s else { return }
            switch state {
            case .ready:
                s.ready = true
                self.post(TunnelFrame(op: .opened, stream: s.id))
                for d in s.early { self.write(s, d) }
                s.early.removeAll()
                s.earlyBytes = 0
                self.read(s)
            case .waiting(let error), .failed(let error):
                // .waiting would retry forever; the Chromebook should hear about it now.
                self.fail(s, Self.reason(error))
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func write(_ s: Stream, _ data: Data) {
        s.connection.send(content: data, completion: .contentProcessed { [weak self, weak s] error in
            if error != nil, let self, let s { self.fail(s, .reset) }
        })
    }

    private func read(_ s: Stream) {
        guard !s.reading, !s.paused, !s.finished else { return }
        s.reading = true
        s.connection.receive(minimumIncompleteLength: 1, maximumLength: Self.readSize) { [weak self, weak s] data, _, isComplete, error in
            guard let self, let s, self.streams[s.id] === s else { return }
            s.reading = false
            if let data, !data.isEmpty {
                self.bytesDown += data.count
                var o = data.startIndex
                while o < data.endIndex {
                    let end = min(o + Self.frameData, data.endIndex)
                    self.enqueue(s, TunnelFrame(op: .data, stream: s.id, payload: data.subdata(in: o..<end)).encoded())
                    o = end
                }
            }
            if isComplete {
                s.finished = true
                self.enqueue(s, TunnelFrame.close(s.id, .normal).encoded())
            } else if let error {
                self.fail(s, Self.reason(error))
            } else if s.queued > Self.pauseAbove {
                s.paused = true   // TCP's own window now holds the server back
            } else {
                self.read(s)
            }
            self.onReady()
        }
    }

    private func fail(_ s: Stream, _ reason: TunnelFrame.Reason) {
        guard streams[s.id] === s, !s.finished else { return }
        s.finished = true
        remove(s)
        s.connection.cancel()
        post(TunnelFrame.close(s.id, reason))
    }

    private func remove(_ s: Stream) {
        streams.removeValue(forKey: s.id)
    }

    static func reason(_ error: NWError) -> TunnelFrame.Reason {
        switch error {
        case .dns: return .dns
        case .posix(let code):
            switch code {
            case .ECONNREFUSED: return .refused
            case .ETIMEDOUT: return .timeout
            case .ENETUNREACH, .EHOSTUNREACH, .ENETDOWN, .EHOSTDOWN: return .unreachable
            default: return .reset
            }
        default: return .reset
        }
    }

    // MARK: - Outgoing

    /// Small frames that unblock the Chromebook (OPENED, CLOSE) jump the queue.
    private func post(_ f: TunnelFrame) {
        urgent.append(f.encoded())
        onReady()
    }

    private func enqueue(_ s: Stream, _ inner: Data) {
        s.frames.append(inner)
        s.queued += inner.count
    }

    /// The next frame to put on the radio: urgent ones first, then the connection that has sent
    /// the fewest bytes lately (decaying by half every second).
    func nextFrame() -> Data? {
        if !urgent.isEmpty { return urgent.removeFirst() }
        let now = CFAbsoluteTimeGetCurrent()
        var best: Stream?
        for s in streams.values where !s.frames.isEmpty {
            s.recent *= pow(0.5, now - s.recentAt)
            s.recentAt = now
            if best == nil || s.recent < best!.recent { best = s }
        }
        guard let s = best else { return nil }
        let f = s.frames.removeFirst()
        s.queued -= f.count
        s.recent += Double(f.count)
        if s.paused, s.queued < Self.pauseAbove / 4 {
            s.paused = false
            read(s)
        }
        if s.finished, s.frames.isEmpty { remove(s) }
        return f
    }
}
