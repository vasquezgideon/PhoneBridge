import Foundation
import WebKit

/// Captures the web view and emits tile messages, paced by the BLE queue:
/// a new frame is only captured once the previous one has drained, so stale frames
/// never pile up. Idle pages produce no traffic (unchanged tiles are skipped).
final class FrameStreamer {
    var settings = DisplaySettings() {
        didSet { if settings != oldValue { requestKeyframe() } }
    }
    /// Return true when the link can take another frame (session unlocked, queue drained).
    var canSend: () -> Bool = { false }
    var sendTile: (Data) -> Void = { _ in }

    private(set) var running = false
    private(set) var framesSent = 0
    private(set) var bytesSent = 0

    private let webView: WKWebView
    private let tileSize = 128
    private var timer: Timer?
    private var capturing = false
    private var keyframeNeeded = true
    private var previous: FrameState?
    private var frameId: UInt32 = 0
    private var lastCapture = Date.distantPast
    private var burstUntil = Date.distantPast
    private let encodeQueue = DispatchQueue(label: "app.phonebridge.encode", qos: .userInitiated)

    init(webView: WKWebView) {
        self.webView = webView
    }

    func start() {
        running = true
        requestKeyframe()
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.tick() }
        }
    }

    func stop() {
        running = false
        timer?.invalidate()
        timer = nil
        previous = nil
    }

    func requestKeyframe() {
        keyframeNeeded = true
        burst()
    }

    /// Capture at up to 10 fps for a short while (after input or navigation).
    func burst(_ seconds: TimeInterval = 1.5) {
        burstUntil = max(burstUntil, Date().addingTimeInterval(seconds))
    }

    private func tick() {
        guard running, !capturing, canSend() else { return }
        let now = Date()
        let interval = now < burstUntil ? 0.1 : 1.0 / max(settings.fps, 0.2)
        guard keyframeNeeded || now.timeIntervalSince(lastCapture) >= interval else { return }
        capture()
    }

    private func capture() {
        capturing = true
        lastCapture = Date()
        let s = settings
        let vp = BrowserController.viewport
        let w = max(64, Int((vp.width * s.scale).rounded()))
        let h = max(40, Int((vp.height * s.scale).rounded()))
        let displayScale = webView.traitCollection.displayScale > 0 ? webView.traitCollection.displayScale : 1

        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: vp)
        config.snapshotWidth = NSNumber(value: Double(w) / Double(displayScale))

        webView.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self else { return }
            guard self.running, let cg = image?.cgImage else { self.capturing = false; return }
            let key = self.keyframeNeeded
            self.keyframeNeeded = false
            let prev = key ? nil : self.previous
            self.frameId &+= 1
            let fid = self.frameId
            let tileSize = self.tileSize
            self.encodeQueue.async {
                let r = TileEncoder.encode(image: cg, width: w, height: h, grayscale: s.grayscale, quality: s.quality,
                                           tileSize: tileSize, tilesEnabled: s.tiles, keyframe: key,
                                           previous: prev, frameId: fid)
                DispatchQueue.main.async {
                    self.capturing = false
                    guard self.running else { return }
                    if r.state != nil || key { self.previous = r.state }
                    guard !r.tiles.isEmpty else { return }
                    for t in r.tiles {
                        self.sendTile(t)
                        self.bytesSent += t.count
                    }
                    self.framesSent += 1
                }
            }
        }
    }
}
