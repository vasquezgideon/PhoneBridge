import Foundation
import Network
import PhoneBridgeCore

/// The iPhone's entire job: open TCP connections the Chromebook asks for and move bytes.
/// It never parses what flows through — HTTPS stays encrypted end-to-end between Chrome on the
/// Chromebook and the website. The only things known here are host:port and byte counts.
///
/// Fairness: each connection has its own outgoing queue; messages are sent round-robin.
/// Backpressure: a connection stops reading from the network while 256 KB of it waits for BLE.
final class TunnelServer {
    static let maxStreams = 256
    static let readSize = 16 * 1024
    static let pauseAbove = 256 * 1024

    /// Hands an inner plaintext (tunnel frame) to the secure channel.
    var sendInner: (Data) -> Void = { _ in }
    /// True when the BLE queue has room.
    var canSend: () -> Bool = { false }

    private(set) var bytesDown = 0     // internet → Chromebook
    private(set) var bytesUp = 0       // Chromebook → internet
    private(set) var totalOpened = 0
    var openCount: Int { streams.count }

    private final class Stream {
        let id: UInt32
        let connection: NWConnection
        var queue: [Data] = []
        var queued = 0
        var reading = false
        var paused = false
        var ready = false
        var finished = false
        init(id: UInt32, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    private var streams: [UInt32: Stream] = [:]
    private var order: [UInt32] = []
    private var cursor = 0

    func handle(_ f: TunnelFrame) {
        switch f.op {
        case .connect: open(f)
        case .data:
            guard let s = streams[f.stream], s.ready else { return }
            bytesUp += f.payload.count
            s.connection.send(content: f.payload, completion: .contentProcessed { [weak self] error in
                if error != nil { self?.fail(s, .reset) }
            })
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
        order.removeAll()
    }

    // MARK: - Connections

    private func open(_ f: TunnelFrame) {
        guard streams[f.stream] == nil else { return }
        guard let target = f.connectTarget, let port = NWEndpoint.Port(rawValue: target.port) else {
            return emit(TunnelFrame.close(f.stream, .bad))
        }
        guard streams.count < Self.maxStreams else { return emit(TunnelFrame.close(f.stream, .limit)) }

        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 20
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        let connection = NWConnection(host: NWEndpoint.Host(target.host), port: port, using: params)
        let s = Stream(id: f.stream, connection: connection)
        streams[f.stream] = s
        order.append(f.stream)
        totalOpened += 1

        connection.stateUpdateHandler = { [weak self, weak s] state in
            guard let self, let s, self.streams[s.id] === s else { return }
            switch state {
            case .ready:
                s.ready = true
                self.enqueue(s, TunnelFrame(op: .opened, stream: s.id))
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

    private func read(_ s: Stream) {
        guard !s.reading, !s.paused, !s.finished else { return }
        s.reading = true
        s.connection.receive(minimumIncompleteLength: 1, maximumLength: Self.readSize) { [weak self, weak s] data, _, isComplete, error in
            guard let self, let s, self.streams[s.id] === s else { return }
            s.reading = false
            if let data, !data.isEmpty {
                self.bytesDown += data.count
                self.enqueue(s, TunnelFrame(op: .data, stream: s.id, payload: data))
            }
            if isComplete {
                s.finished = true
                self.enqueue(s, TunnelFrame.close(s.id, .normal))
            } else if let error {
                self.fail(s, Self.reason(error))
            } else if s.queued > Self.pauseAbove {
                s.paused = true
            } else {
                self.read(s)
            }
        }
    }

    private func fail(_ s: Stream, _ reason: TunnelFrame.Reason) {
        guard streams[s.id] === s, !s.finished else { return }
        s.finished = true
        s.queue.removeAll()
        s.queued = 0
        enqueue(s, TunnelFrame.close(s.id, reason))
        s.connection.cancel()
    }

    private func remove(_ s: Stream) {
        streams.removeValue(forKey: s.id)
        order.removeAll { $0 == s.id }
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

    // MARK: - Outgoing queue

    private func emit(_ f: TunnelFrame) { sendInner(f.encoded()) }

    private func enqueue(_ s: Stream, _ f: TunnelFrame) {
        let inner = f.encoded()
        s.queue.append(inner)
        s.queued += inner.count
        pump()
    }

    /// Sends as much as BLE will take, round-robin across connections.
    func pump() {
        while canSend(), let s = nextStream() {
            let inner = s.queue.removeFirst()
            s.queued -= inner.count
            sendInner(inner)
            if s.paused, s.queued < Self.pauseAbove / 4 {
                s.paused = false
                read(s)
            }
            if s.finished, s.queue.isEmpty {
                remove(s)
            }
        }
    }

    private func nextStream() -> Stream? {
        guard !order.isEmpty else { return nil }
        for _ in 0..<order.count {
            cursor = (cursor + 1) % order.count
            if let s = streams[order[cursor]], !s.queue.isEmpty { return s }
        }
        return nil
    }
}
