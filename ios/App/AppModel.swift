import Foundation
import UIKit
import Network
import PhoneBridgeCore

struct PairingPrompt: Identifiable {
    let id = UUID()
    let code: String
    let deviceName: String
}

/// Host orchestration: BLE link ⇄ handshake ⇄ secure channel ⇄ browser + frame streamer.
/// Everything runs on the main queue.
final class AppModel: NSObject, ObservableObject, PhoneHandshakeDelegate {
    enum LinkState: Equatable {
        case waiting, handshaking, pairing, locked(String), connected(String)

        var label: String {
            switch self {
            case .waiting: return "Waiting for Chromebook"
            case .handshaking: return "Chromebook connected — authenticating"
            case .pairing: return "Pairing — check the code"
            case .locked(let n): return "\(n) — waiting for password"
            case .connected(let n): return "Connected to \(n)"
            }
        }
    }

    @Published var settings: HostSettings { didSet { settingsChanged(from: oldValue) } }
    @Published var pairingPrompt: PairingPrompt?
    @Published private(set) var bluetoothText = "Starting Bluetooth…"
    @Published private(set) var link: LinkState = .waiting
    @Published private(set) var pairingOpenUntil: Date?
    @Published private(set) var devices: [TrustedDevice] = []
    @Published private(set) var passwordSet = false
    @Published private(set) var currentDeviceId: String?
    @Published private(set) var stats = ""
    @Published private(set) var network = "unknown"
    @Published private(set) var log: [String] = []

    let browser: BrowserController
    let security = SecurityStore()
    let streamer: FrameStreamer
    private let ble = BLEPeripheral()

    private var assembler = FrameAssembler()
    private var handshake: PhoneHandshake?
    private var channel: SecureChannel?
    private var currentDevice: TrustedDevice?
    private var unlocked = false
    private var streamEnabled = true
    private var pairingFailures = 0
    private var pairingTimer: Timer?
    private var tickTimer: Timer?
    private var statusCountdown = 0
    private var lastSent = 0, lastReceived = 0, lastFrames = 0
    private var benchC2P: (expected: Int, received: Int, started: Date?)?
    private let pathMonitor = NWPathMonitor()
    private var observers: [NSObjectProtocol] = []

    override init() {
        settings = HostSettings.load()
        let browser = BrowserController()
        self.browser = browser
        streamer = FrameStreamer(webView: browser.webView)
        super.init()

        devices = security.devices
        passwordSet = security.passwordSet
        browser.homepage = settings.homepage
        browser.searchTemplate = settings.searchTemplate
        streamer.settings = settings.display
        streamer.canSend = { [weak self] in self?.canStream ?? false }
        streamer.sendTile = { [weak self] tile in self?.sendInner(tile) }

        browser.onStateChange = { [weak self] in
            guard let self, self.unlocked else { return }
            self.sendControl(self.browser.stateMessage)
        }
        browser.onContentHint = { [weak self] in self?.streamer.burst() }

        ble.onStateText = { [weak self] text in self?.bluetoothText = text }
        ble.onConnect = { [weak self] _ in self?.clientConnected() }
        ble.onDisconnect = { [weak self] in self?.clientDisconnected() }
        ble.onReceive = { [weak self] data in self?.receive(data) }

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
        let names: [Notification.Name] = [UIDevice.batteryLevelDidChangeNotification,
                                          UIDevice.batteryStateDidChangeNotification,
                                          ProcessInfo.thermalStateDidChangeNotification]
        for name in names {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.sendStatus()
            })
        }

        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        applyIdleTimer()
        browser.goHome()
    }

    // MARK: - Settings

    private func settingsChanged(from old: HostSettings) {
        settings.save()
        browser.homepage = settings.homepage
        browser.searchTemplate = settings.searchTemplate
        streamer.settings = settings.display
        if old.keepScreenAwake != settings.keepScreenAwake { applyIdleTimer() }
        if old.display != settings.display { sendControl(settings.display.message) }
        if old.requirePasswordEveryReconnect != settings.requirePasswordEveryReconnect { sendSecurity() }
    }

    private func applyIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = settings.keepScreenAwake
    }

    // MARK: - Link lifecycle

    private func clientConnected() {
        resetSession()
        assembler.reset()
        newHandshake()
        addLog("Chromebook connected (BLE packet \(ble.packetSize) B)")
    }

    private func clientDisconnected() {
        resetSession()
        assembler.reset()
        link = .waiting
        addLog("Chromebook disconnected")
    }

    private func newHandshake() {
        handshake?.cancel()
        let h = PhoneHandshake(phoneName: settings.hostName, phoneId: security.phoneId)
        h.delegate = self
        handshake = h
        link = .handshaking
    }

    private func resetSession() {
        handshake?.cancel()
        handshake = nil
        channel = nil
        currentDevice = nil
        currentDeviceId = nil
        unlocked = false
        streamEnabled = true
        benchC2P = nil
        pairingPrompt = nil
        streamer.stop()
    }

    /// Ends the secure session but keeps the BLE link so the Chromebook can handshake again.
    private func restartHandshake(code: String, message: String) {
        if channel != nil {
            ble.send(FrameAssembler.frame(HandshakeMessage.error(code, message).payload()))
        }
        resetSession()
        newHandshake()
    }

    private var canStream: Bool {
        channel != nil && unlocked && streamEnabled && benchC2P == nil && ble.pendingBytes < 2048
    }

    // MARK: - Receive

    private func receive(_ data: Data) {
        let frames: [Data]
        do {
            frames = try assembler.append(data)
        } catch {
            addLog("Framing error: \(error)")
            assembler.reset()
            return restartHandshake(code: "bad_frame", message: "Framing error")
        }
        for frame in frames {
            guard let type = frame.first else { continue }
            if type == PBWire.Outer.handshake.rawValue {
                if channel == nil {
                    if handshake == nil || handshake?.isComplete == true { newHandshake() }
                    handshake?.receive(frame)
                }
            } else if type == PBWire.Outer.secure.rawValue, let channel {
                do {
                    handleInner(try channel.open(frame))
                } catch {
                    addLog("Decryption failed (\(error)) — session reset")
                    return restartHandshake(code: "session_reset", message: "Decryption failed")
                }
            }
        }
    }

    private func handleInner(_ pt: Data) {
        switch pt.first ?? 0 {
        case PBWire.Inner.control.rawValue:
            if let m = ControlMessage.decode(pt) { handleControl(m) }
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

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }

    private func handleControl(_ m: [String: Any]) {
        guard let t = m["t"] as? String else { return }
        switch t {
        case "auth_password": return authenticate(m)
        case "ping": return sendControl(["t": "pong", "id": m["id"] ?? 0])
        default: break
        }
        guard unlocked else { return }

        switch t {
        case "navigate":
            if let u = m["url"] as? String { browser.navigate(u); streamer.burst(3) }
        case "nav":
            if let a = m["action"] as? String { browser.perform(a); streamer.burst(3) }
        case "ptr":
            let a = m["a"] as? String ?? "move"
            browser.pointer(a, nx: num(m["x"]), ny: num(m["y"]), button: Int(num(m["b"])))
            streamer.burst(a == "move" ? 0.6 : 1.5)
        case "wheel":
            browser.wheel(nx: num(m["x"]), ny: num(m["y"]), dx: num(m["dx"]), dy: num(m["dy"]))
            streamer.burst()
        case "text":
            if let s = m["s"] as? String { browser.text(s); streamer.burst() }
        case "key":
            if let k = m["key"] as? String {
                browser.key(k, ctrl: m["ctrl"] as? Bool ?? false, alt: m["alt"] as? Bool ?? false,
                            shift: m["shift"] as? Bool ?? false, meta: m["meta"] as? Bool ?? false)
                streamer.burst()
            }
        case "display":
            var d = settings.display
            d.apply(m)
            if d == settings.display { sendControl(d.message) } else { settings.display = d }
        case "browser_prefs":
            if let h = m["homepage"] as? String, !h.isEmpty { settings.homepage = h }
            if let s = m["search"] as? String, s.contains("%s") { settings.searchTemplate = s }
        case "stream":
            streamEnabled = m["on"] as? Bool ?? true
            if streamEnabled { streamer.requestKeyframe() }
        case "refresh":
            streamer.requestKeyframe()
        case "get_security":
            sendSecurity()
        case "set_password":
            remoteSetPassword(current: m["current"] as? String, new: m["password"] as? String ?? "")
        case "remove_password":
            remoteRemovePassword(current: m["current"] as? String ?? "")
        case "set_require_every":
            settings.requirePasswordEveryReconnect = m["value"] as? Bool ?? false
        case "revoke":
            if let id = m["id"] as? String { revoke(id: id) }
        case "bench":
            startBench(dir: m["dir"] as? String ?? "p2c", bytes: Int(num(m["bytes"])))
        case "bench_done":
            finishBenchC2P()
        default:
            break
        }
    }

    // MARK: - Sending

    private func sendControl(_ m: [String: Any]) { sendInner(ControlMessage.encode(m)) }

    private func sendInner(_ plaintext: Data) {
        guard let channel else { return }
        do {
            ble.send(FrameAssembler.frame(try channel.seal(plaintext)))
        } catch {
            addLog("Encrypt failed: \(error)")
        }
    }

    private func sendSecurity() {
        guard unlocked else { return }
        let list: [[String: Any]] = security.devices.map {
            ["id": $0.id, "name": $0.name, "pairedAt": $0.pairedAt.timeIntervalSince1970 * 1000,
             "lastSeen": $0.lastSeen.timeIntervalSince1970 * 1000, "remembered": $0.passwordRemembered,
             "current": $0.id == currentDevice?.id]
        }
        sendControl(["t": "security", "passwordSet": security.passwordSet,
                     "requireEvery": settings.requirePasswordEveryReconnect, "devices": list])
    }

    private func sendStatus() {
        guard unlocked else { return }
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
                     "thermal": thermal, "network": network])
    }

    private func notice(_ msg: String, level: String = "info") {
        sendControl(["t": "notice", "level": level, "msg": msg])
    }

    // MARK: - Handshake delegate

    func handshake(_ h: PhoneHandshake, trustedDeviceFor id: String) -> TrustedDevice? { security.device(id: id) }

    func handshakePairingAllowed(_ h: PhoneHandshake) -> Bool {
        guard let until = pairingOpenUntil else { return false }
        return until > Date()
    }

    func handshake(_ h: PhoneHandshake, requestApprovalFor code: String, deviceName: String) {
        link = .pairing
        pairingPrompt = PairingPrompt(code: code, deviceName: deviceName)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    func handshake(_ h: PhoneHandshake, send payload: Data) {
        ble.send(FrameAssembler.frame(payload))
    }

    func handshake(_ h: PhoneHandshake, completed device: TrustedDevice, channel: SecureChannel, newlyPaired: Bool) {
        pairingPrompt = nil
        if newlyPaired {
            security.upsert(device)
            closePairing()
            pairingFailures = 0
            addLog("Paired with \(device.name)")
        }
        self.channel = channel
        currentDevice = security.device(id: device.id) ?? device
        currentDeviceId = device.id
        security.touch(id: device.id)
        devices = security.devices

        let needsPassword = !newlyPaired && security.passwordSet &&
            (settings.requirePasswordEveryReconnect || !(currentDevice?.passwordRemembered ?? false))
        unlocked = !needsPassword
        sendControl(["t": "welcome", "phone": settings.hostName, "phoneId": security.phoneId.base64EncodedString(),
                     "locked": needsPassword, "passwordSet": security.passwordSet, "proto": PBWire.protocolVersion])
        if unlocked {
            sessionUnlocked()
        } else {
            link = .locked(device.name)
            sendControl(["t": "auth_required", "lockoutSeconds": Int(security.lockoutRemaining.rounded(.up))])
            addLog("\(device.name) connected — password required")
        }
    }

    func handshake(_ h: PhoneHandshake, failed code: String, message: String, duringPairing: Bool) {
        pairingPrompt = nil
        addLog("Handshake failed: \(code) — \(message)")
        if duringPairing {
            pairingFailures += 1
            if pairingFailures >= 3 {
                closePairing()
                addLog("Pairing closed after 3 failed attempts")
            }
        }
        // Stay ready for another attempt on the same connection.
        if h === handshake { newHandshake() }
    }

    private func sessionUnlocked() {
        guard let device = currentDevice else { return }
        link = .connected(device.name)
        addLog("Session unlocked for \(device.name)")
        sendControl(browser.stateMessage)
        sendControl(settings.display.message)
        sendSecurity()
        sendStatus()
        streamer.start()
    }

    // MARK: - Password

    private func authenticate(_ m: [String: Any]) {
        guard channel != nil, !unlocked, let device = currentDevice else { return }
        switch security.checkPassword(m["password"] as? String ?? "") {
        case .ok, .notSet:
            if m["remember"] as? Bool == true { security.setRemembered(id: device.id, true) }
            devices = security.devices
            unlocked = true
            sendControl(["t": "auth_result", "ok": true])
            sessionUnlocked()
        case .wrong(let lockout):
            addLog("Wrong password from \(device.name)")
            sendControl(["t": "auth_result", "ok": false, "error": "wrong_password", "lockoutSeconds": Int(lockout)])
        case .lockedOut(let remaining):
            sendControl(["t": "auth_result", "ok": false, "error": "locked_out", "lockoutSeconds": Int(remaining.rounded(.up))])
        }
    }

    private func remoteSetPassword(current: String?, new: String) {
        guard new.count >= 4 else { return notice("Password must be at least 4 characters.", level: "error") }
        if security.passwordSet {
            guard case .ok = security.checkPassword(current ?? "") else {
                return notice("Current password is incorrect.", level: "error")
            }
        }
        security.setPassword(new, keepRememberedFor: currentDevice?.id)
        passwordSet = true
        devices = security.devices
        addLog("Password changed from \(currentDevice?.name ?? "Chromebook")")
        notice("Password saved.")
        sendSecurity()
    }

    private func remoteRemovePassword(current: String) {
        guard security.passwordSet else { return sendSecurity() }
        guard case .ok = security.checkPassword(current) else {
            return notice("Current password is incorrect.", level: "error")
        }
        security.setPassword(nil)
        passwordSet = false
        addLog("Password removed from \(currentDevice?.name ?? "Chromebook")")
        notice("Password removed.")
        sendSecurity()
    }

    // MARK: - Benchmark

    private func startBench(dir: String, bytes: Int) {
        let n = min(max(bytes, 1024), 4 * 1024 * 1024)
        if dir == "c2p" {
            benchC2P = (expected: n, received: 0, started: nil)
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
        addLog("Benchmark: queued \(n / 1024) KB to Chromebook")
    }

    private func finishBenchC2P() {
        guard let b = benchC2P else { return }
        let ms = (b.started.map { Date().timeIntervalSince($0) } ?? 0) * 1000
        benchC2P = nil
        sendControl(["t": "bench_result", "dir": "c2p", "bytes": b.received, "ms": ms])
        let kbps = ms > 0 ? Double(b.received) * 8 / ms : 0
        addLog(String(format: "Benchmark Chromebook→iPhone: %ld KB in %.0f ms (%.0f kbit/s)", b.received / 1024, ms, kbps))
        streamer.requestKeyframe()
    }

    // MARK: - Phone UI actions

    func openPairing() {
        pairingOpenUntil = Date().addingTimeInterval(120)
        pairingFailures = 0
        pairingTimer?.invalidate()
        pairingTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in self?.closePairing() }
        addLog("Pairing open for 2 minutes")
    }

    func closePairing() {
        pairingOpenUntil = nil
        pairingTimer?.invalidate()
        pairingTimer = nil
    }

    func answerPairing(_ approve: Bool) {
        pairingPrompt = nil
        handshake?.approve(approve)
    }

    func setPasswordLocally(_ password: String) {
        security.setPassword(password)
        passwordSet = true
        devices = security.devices
        addLog("Password set on iPhone")
        sendSecurity()
    }

    func removePasswordLocally() {
        security.setPassword(nil)
        passwordSet = false
        devices = security.devices
        addLog("Password removed on iPhone")
        sendSecurity()
    }

    func revoke(id: String) {
        let name = security.device(id: id)?.name ?? "device"
        security.remove(id: id)
        devices = security.devices
        addLog("Revoked \(name)")
        if id == currentDevice?.id {
            sendControl(["t": "revoked"])
            restartHandshake(code: "revoked", message: "This Chromebook was removed")
        } else {
            sendSecurity()
        }
    }

    func factoryReset() {
        if channel != nil {
            sendControl(["t": "revoked"])
            restartHandshake(code: "revoked", message: "PhoneBridge was reset on the iPhone")
        }
        security.factoryReset()
        devices = []
        passwordSet = false
        settings = HostSettings()
        browser.clearWebsiteData { [weak self] in self?.browser.goHome() }
        addLog("Factory reset complete")
    }

    // MARK: - Housekeeping

    private func tick() {
        let sent = ble.bytesSent, received = ble.bytesReceived, frames = streamer.framesSent
        let up = max(0, sent - lastSent), down = max(0, received - lastReceived), fps = max(0, frames - lastFrames)
        lastSent = sent; lastReceived = received; lastFrames = frames
        stats = ble.isConnected
            ? String(format: "↑ %.1f kB/s · ↓ %.1f kB/s · %ld frame%@/s · queue %ld B", Double(up) / 1024, Double(down) / 1024,
                     fps, fps == 1 ? "" : "s", ble.pendingBytes)
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
