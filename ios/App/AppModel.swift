import Foundation
import UIKit
import Network
import PhoneBridgeCore

/// Host orchestration: BLE link ⇄ password handshake ⇄ secure channel ⇄ TCP tunnel.
/// The iPhone is only the Chromebook's modem: it renders nothing, sees no URLs or page content
/// (HTTPS is encrypted on the Chromebook), and has no controls over browsing.
/// Everything runs on the main queue.
final class AppModel: NSObject, ObservableObject, PhoneHandshakeDelegate {
    enum LinkState: Equatable {
        case waiting, authenticating, connected(String)

        var label: String {
            switch self {
            case .waiting: return "Ready — waiting for a Chromebook"
            case .authenticating: return "Chromebook connecting…"
            case .connected(let n): return "Connected to \(n)"
            }
        }
    }

    @Published var settings: HostSettings { didSet { settingsChanged(from: oldValue) } }
    @Published private(set) var password: String
    @Published private(set) var bluetoothText = "Starting Bluetooth…"
    @Published private(set) var link: LinkState = .waiting
    @Published private(set) var stats = ""
    @Published private(set) var network = "unknown"
    @Published private(set) var openConnections = 0
    @Published private(set) var log: [String] = []
    @Published private(set) var totalDown = 0
    @Published private(set) var totalUp = 0

    private let passwords = PasswordStore()
    private let limiter = AttemptLimiter()
    private let ble = BLEPeripheral()
    private let tunnel = TunnelServer()
    private var assembler = FrameAssembler()
    private var handshake: PhoneHandshake?
    private var channel: SecureChannel?
    private var client: ClientInfo?
    private var benchC2P: (received: Int, started: Date?)?
    /// Control and benchmark plaintexts, sent before any tunnel data (see flush()).
    private var outgoing: [Data] = []
    private var tickTimer: Timer?
    private var statusCountdown = 0
    private var lastSent = 0, lastReceived = 0
    private let pathMonitor = NWPathMonitor()
    private var observers: [NSObjectProtocol] = []

    override init() {
        settings = HostSettings.load()
        password = ""
        super.init()
        password = passwords.password

        tunnel.onReady = { [weak self] in self?.flush() }

        ble.onStateText = { [weak self] text in self?.bluetoothText = text }
        ble.onConnect = { [weak self] _ in self?.clientConnected() }
        ble.onDisconnect = { [weak self] in self?.clientDisconnected() }
        ble.onReceive = { [weak self] data in self?.receive(data) }
        ble.onDrain = { [weak self] in self?.flush() }

        pathMonitor.pathUpdateHandler = { [weak self] path in
            let s: String
            if path.status != .satisfied { s = "none" }
            else if path.usesInterfaceType(.cellular) { s = "cellular" }
            else if path.usesInterfaceType(.wifi) { s = "wifi" }
            else { s = "other" }
            DispatchQueue.main.async {
                self?.network = s
                self?.sendStatus()
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "app.phonebridge.path"))

        UIDevice.current.isBatteryMonitoringEnabled = true
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification,
                     ProcessInfo.thermalStateDidChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.sendStatus()
            })
        }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        applyIdleTimer()
    }

    // MARK: - Settings / password

    private func settingsChanged(from old: HostSettings) {
        settings.save()
        if old.keepScreenAwake != settings.keepScreenAwake { applyIdleTimer() }
    }

    private func applyIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = settings.keepScreenAwake
    }

    /// Changing the password signs the current Chromebook out; it must use the new one.
    func setPassword(_ new: String) {
        let trimmed = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= PasswordStore.minLength else { return }
        passwords.set(trimmed)
        password = trimmed
        limiter.succeeded()
        addLog("Password changed")
        if channel != nil { endSession(code: "password_changed", message: "The password was changed on the iPhone.") }
    }

    func randomPassword() -> String { PasswordStore.random() }

    // MARK: - Link lifecycle

    private func clientConnected() {
        resetSession()
        assembler.reset()
        newHandshake()
        addLog("Chromebook connected over BLE (packet \(ble.packetSize) B)")
    }

    private func clientDisconnected() {
        resetSession()
        assembler.reset()
        link = .waiting
        addLog("Chromebook disconnected")
    }

    private func newHandshake() {
        handshake?.cancel()
        let h = PhoneHandshake(phoneName: settings.hostName, limiter: limiter)
        h.delegate = self
        handshake = h
        link = .authenticating
    }

    private func resetSession() {
        handshake?.cancel()
        handshake = nil
        channel = nil
        client = nil
        benchC2P = nil
        outgoing.removeAll()
        tunnel.reset()
    }

    /// Ends the secure session but keeps BLE up so the Chromebook can authenticate again.
    private func endSession(code: String, message: String) {
        ble.send(FrameAssembler.frame(HandshakeMessage.error(code, message).payload()))
        resetSession()
        newHandshake()
    }

    // MARK: - Receive

    private func receive(_ data: Data) {
        let frames: [Data]
        do {
            frames = try assembler.append(data)
        } catch {
            addLog("Framing error: \(error)")
            assembler.reset()
            return endSession(code: "bad_frame", message: "Framing error")
        }
        for frame in frames {
            guard let type = frame.first else { continue }
            if type == PBWire.Outer.handshake.rawValue {
                guard channel == nil else { continue }
                if handshake == nil || handshake?.isFinished == true { newHandshake() }
                handshake?.receive(frame)
            } else if type == PBWire.Outer.secure.rawValue, let channel {
                do {
                    handleInner(try channel.open(frame))
                } catch {
                    addLog("Decryption failed (\(error)) — session reset")
                    return endSession(code: "session_reset", message: "Decryption failed")
                }
            }
        }
    }

    private func handleInner(_ pt: Data) {
        switch pt.first ?? 0 {
        case PBWire.Inner.control.rawValue:
            if let m = ControlMessage.decode(pt) { handleControl(m) }
        case PBWire.Inner.tunnel.rawValue:
            if let frame = TunnelFrame(decoding: pt) { tunnel.handle(frame) }
        case PBWire.Inner.bench.rawValue:
            if var b = benchC2P {
                if b.started == nil { b.started = Date() }
                b.received += pt.count - 1
                benchC2P = b
            }
        default:
            break
        }
    }

    private func handleControl(_ m: [String: Any]) {
        // The Chromebook's only control messages: liveness, status, benchmark. Nothing from the
        // iPhone can steer the Chromebook.
        switch m["t"] as? String {
        case "ping": sendControl(["t": "pong", "id": m["id"] ?? 0])
        case "status": sendStatus()
        case "bench": startBench(dir: m["dir"] as? String ?? "p2c", bytes: (m["bytes"] as? NSNumber)?.intValue ?? 0)
        case "bench_done": finishBenchC2P()
        default: break
        }
    }

    // MARK: - Sending

    private func sendControl(_ m: [String: Any]) { sendInner(ControlMessage.encode(m)) }

    private func sendInner(_ plaintext: Data) {
        guard channel != nil else { return }
        outgoing.append(plaintext)
        flush()
    }

    /// Seals and hands frames to Bluetooth only while its queue is short. Sealing fixes the order
    /// (strict counters), so deciding what goes next has to happen here, before sealing: control
    /// messages first, then whatever the tunnel scheduler picks.
    private func flush() {
        guard let channel else { return }
        while ble.pendingBytes < ble.radioLowWater {
            let pt: Data
            if !outgoing.isEmpty { pt = outgoing.removeFirst() }
            else if let f = tunnel.nextFrame() { pt = f }
            else { return }
            do {
                ble.send(FrameAssembler.frame(try channel.seal(pt)))
            } catch {
                addLog("Encrypt failed: \(error)")
                return
            }
        }
    }

    private func sendStatus() {
        guard channel != nil else { return }
        let d = UIDevice.current
        let thermal: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }
        sendControl(["t": "status", "battery": Double(d.batteryLevel), "charging": d.batteryState == .charging || d.batteryState == .full,
                     "thermal": thermal, "network": network, "mtu": ble.packetSize])
    }

    // MARK: - Handshake delegate

    func handshakeGenerator(_ h: PhoneHandshake) -> Data { passwords.generator }

    func handshake(_ h: PhoneHandshake, send payload: Data) {
        ble.send(FrameAssembler.frame(payload))
    }

    func handshake(_ h: PhoneHandshake, completed client: ClientInfo, channel: SecureChannel) {
        self.channel = channel
        self.client = client
        link = .connected(client.name)
        addLog("\(client.name) signed in")
        // features: what this app can do beyond protocol v3. "early-data": bytes for a connection
        // that's still opening are buffered, so the Chromebook needn't wait for OPENED.
        // mtu: the negotiated notification size, so the Chromebook writes full-size packets too.
        sendControl(["t": "welcome", "phone": settings.hostName, "proto": PBWire.protocolVersion,
                     "features": ["early-data"], "mtu": ble.packetSize])
        sendStatus()
    }

    func handshake(_ h: PhoneHandshake, failed code: String, message: String) {
        addLog("Sign-in failed: \(code)")
        if h === handshake { newHandshake() }
    }

    // MARK: - Benchmark

    private func startBench(dir: String, bytes: Int) {
        let n = min(max(bytes, 1024), 4 * 1024 * 1024)
        if dir == "c2p" {
            benchC2P = (received: 0, started: nil)
            return
        }
        sendControl(["t": "bench_start", "bytes": n])
        var left = n
        while left > 0 {
            let chunk = min(4000, left)
            var d = Data([PBWire.Inner.bench.rawValue])
            d.append(Data(count: chunk))
            sendInner(d)
            left -= chunk
        }
        sendControl(["t": "bench_end", "bytes": n])
    }

    private func finishBenchC2P() {
        guard let b = benchC2P else { return }
        let ms = (b.started.map { Date().timeIntervalSince($0) } ?? 0) * 1000
        benchC2P = nil
        sendControl(["t": "bench_result", "dir": "c2p", "bytes": b.received, "ms": ms])
        addLog(String(format: "Benchmark Chromebook→iPhone: %ld KB in %.0f ms", b.received / 1024, ms))
    }

    // MARK: - Housekeeping

    private func tick() {
        let sent = ble.bytesSent, received = ble.bytesReceived
        let up = max(0, sent - lastSent), down = max(0, received - lastReceived)
        lastSent = sent; lastReceived = received
        totalDown = tunnel.bytesDown
        totalUp = tunnel.bytesUp
        openConnections = tunnel.openCount
        stats = ble.isConnected
            ? String(format: "To Chromebook %.1f kB/s · from %.1f kB/s · queue %ld B",
                     Double(up) / 1024, Double(down) / 1024, ble.pendingBytes)
            : ""
        statusCountdown += 1
        if statusCountdown >= 20 { statusCountdown = 0; sendStatus() }
    }

    func addLog(_ s: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        log.append("\(f.string(from: Date()))  \(s)")
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }
}
