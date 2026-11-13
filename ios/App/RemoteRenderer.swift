import UIKit
import WebKit
import SwiftUI
import PhoneBridgeCore

/// "iPhone renders" mode (opt-in on the Chromebook). The page loads here in WKWebView at the
/// Chromebook's window size; what changed since the last picture is sent as JPEG strips; clicks,
/// scrolling and typing come back. Only the visible picture crosses Bluetooth, and every round trip
/// to the website happens on the iPhone's own connection. In this mode the iPhone necessarily sees
/// the pages; the default mode (Chromebook renders) stays the private one.
///
/// Flow control: one picture in flight. The next is taken only after the Chromebook acks the
/// previous one, so pictures never queue up behind each other on the radio.
final class RemoteRenderer: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    static let tile = 64
    /// Above this share of changed tiles (scrolling, new page) one whole-picture JPEG is cheaper.
    static let wholeAbove = 0.4

    var sendFrame: (Data) -> Void = { _ in }              // inner plaintext (0x05 …)
    var sendState: ([String: Any]) -> Void = { _ in }     // control message
    var quality: CGFloat = 0.5

    @Published private(set) var active = false
    @Published private(set) var viewSize = CGSize(width: 1280, height: 720)
    let webView: WKWebView

    private var seq: UInt32 = 0
    private var waiting: UInt32 = 0
    private var previous: [UInt8] = []
    private var timer: Timer?
    private var busy = false
    private var lastState = ""
    private var observations: [NSKeyValueObservation] = []
    private(set) var bytesSent = 0

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // Input helper lives in an isolated world: the page can't see or call it.
        cfg.userContentController.addUserScript(WKUserScript(source: Self.inputScript, injectionTime: .atDocumentStart,
                                                             forMainFrameOnly: true, in: .defaultClient))
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 720), configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isUserInteractionEnabled = false
        // A desktop user agent: the Chromebook's window is desktop-sized, so ask for desktop layouts.
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        let report: () -> Void = { [weak self] in self?.reportState() }
        observations = [
            webView.observe(\.url) { _, _ in report() },
            webView.observe(\.title) { _, _ in report() },
            webView.observe(\.isLoading) { _, _ in report() },
            webView.observe(\.canGoBack) { _, _ in report() },
            webView.observe(\.canGoForward) { _, _ in report() },
            webView.observe(\.estimatedProgress) { _, _ in report() },
        ]
    }

    // MARK: - Commands from the Chromebook

    func handle(_ m: [String: Any]) {
        let num = { (k: String) -> Double in (m[k] as? NSNumber)?.doubleValue ?? 0 }
        switch m["t"] as? String {
        case "rv_start":
            start(width: Int(num("w")), height: Int(num("h")), url: m["url"] as? String)
        case "rv_resize":
            resize(width: Int(num("w")), height: Int(num("h")))
        case "rv_stop": stop()
        case "rv_nav": if let s = m["url"] as? String { navigate(s) }
        case "rv_back": webView.goBack()
        case "rv_forward": webView.goForward()
        case "rv_reload": webView.reload()
        case "rv_halt": webView.stopLoading()
        case "rv_ack":
            if UInt32(num("seq")) == waiting { waiting = 0; tick() }
        case "rv_input":
            guard active, let json = try? JSONSerialization.data(withJSONObject: m),
                  let arg = String(data: json, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.__pbInput(\(arg))", in: nil, in: .defaultClient) { _ in }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.tick() }
        default: break
        }
    }

    private func start(width: Int, height: Int, url: String?) {
        resize(width: width, height: height)
        previous = []
        waiting = 0
        active = true
        lastState = ""
        if let url, !url.isEmpty, webView.url?.absoluteString != url { navigate(url) }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in self?.tick() }
        reportState()
    }

    private func resize(width: Int, height: Int) {
        let size = CGSize(width: min(max(width, 320), 2560), height: min(max(height, 240), 1600))
        viewSize = size
        webView.bounds = CGRect(origin: .zero, size: size)
        previous = []   // next picture is a whole one
    }

    func stop() {
        active = false
        timer?.invalidate()
        timer = nil
        waiting = 0
        previous = []
    }

    private func navigate(_ s: String) {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        webView.load(URLRequest(url: u))
    }

    // MARK: - State

    private func reportState() {
        guard active else { return }
        let m: [String: Any] = [
            "t": "rv_state", "url": webView.url?.absoluteString ?? "", "title": webView.title ?? "",
            "loading": webView.isLoading, "canBack": webView.canGoBack, "canForward": webView.canGoForward,
            "progress": (webView.estimatedProgress * 100).rounded() / 100,
        ]
        let key = "\(m["url"]!)|\(m["title"]!)|\(m["loading"]!)|\(m["canBack"]!)|\(m["canForward"]!)|\(m["progress"]!)"
        guard key != lastState else { return }
        lastState = key
        sendState(m)
    }

    // window.open / target=_blank: open in the same view (there's one "tab").
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    // MARK: - Pictures

    private func tick() {
        guard active, !busy, waiting == 0, webView.window != nil else { return }
        busy = true
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(origin: .zero, size: viewSize)
        cfg.snapshotWidth = NSNumber(value: Double(viewSize.width))   // 1 pixel per CSS pixel
        cfg.afterScreenUpdates = false
        webView.takeSnapshot(with: cfg) { [weak self] image, _ in
            guard let self else { return }
            defer { self.busy = false }
            guard self.active, self.waiting == 0, let cg = image?.cgImage else { return }
            self.encode(cg)
        }
    }

    private func encode(_ cg: CGImage) {
        let w = cg.width, h = cg.height, stride = w * 4
        var px = [UInt8](repeating: 0, count: stride * h)
        let drawn: Bool = px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: stride,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return }

        let T = Self.tile
        let cols = (w + T - 1) / T, rows = (h + T - 1) / T
        var changed = [[Bool]](repeating: [Bool](repeating: false, count: cols), count: rows)
        var count = 0
        let whole = previous.count != px.count
        if !whole {
            px.withUnsafeBufferPointer { a in
                previous.withUnsafeBufferPointer { b in
                    for r in 0..<rows {
                        for c in 0..<cols {
                            let x0 = c * T, y0 = r * T, tw = min(T, w - x0), th = min(T, h - y0)
                            var diff = false
                            for y in y0..<(y0 + th) where !diff {
                                let o = y * stride + x0 * 4
                                diff = memcmp(a.baseAddress! + o, b.baseAddress! + o, tw * 4) != 0
                            }
                            if diff { changed[r][c] = true; count += 1 }
                        }
                    }
                }
            }
            if count == 0 { return }
        }

        seq &+= 1
        if seq == 0 { seq = 1 }
        var frames: [Data] = []
        func strip(_ x: Int, _ y: Int, _ sw: Int, _ sh: Int) {
            guard let part = cg.cropping(to: CGRect(x: x, y: y, width: sw, height: sh)),
                  let jpeg = UIImage(cgImage: part).jpegData(compressionQuality: quality) else { return }
            frames.append(Self.frame(.tile, seq, x, y, sw, sh, jpeg))
        }
        if whole || Double(count) > Self.wholeAbove * Double(rows * cols) {
            strip(0, 0, w, h)
        } else {
            // Neighbouring changed tiles in a row become one strip: fewer JPEG headers.
            for r in 0..<rows {
                var c = 0
                while c < cols {
                    guard changed[r][c] else { c += 1; continue }
                    let start = c
                    while c < cols && changed[r][c] { c += 1 }
                    let x0 = start * T, y0 = r * T
                    strip(x0, y0, min(c * T, w) - x0, min(T, h - y0))
                }
            }
        }
        previous = px
        frames.append(Self.frame(.end, seq, 0, 0, w, h, Data()))
        waiting = seq
        for f in frames { bytesSent += f.count; sendFrame(f) }
    }

    enum Kind: UInt8 { case tile = 1, end = 2 }

    /// 0x05 | u8 kind | u32 seq | u16 x | u16 y | u16 w | u16 h | data
    static func frame(_ kind: Kind, _ seq: UInt32, _ x: Int, _ y: Int, _ w: Int, _ h: Int, _ data: Data) -> Data {
        var d = Data([PBWire.Inner.remote.rawValue, kind.rawValue])
        d.appendBE(seq)
        d.appendBE(UInt16(x)); d.appendBE(UInt16(y)); d.appendBE(UInt16(w)); d.appendBE(UInt16(h))
        d.append(data)
        return d
    }

    // MARK: - Input (runs in an isolated JavaScript world; events are synthetic)

    static let inputScript = """
    (() => {
      const opts = (m, extra) => Object.assign({ bubbles: true, cancelable: true, view: window, clientX: m.x, clientY: m.y, button: 0 }, extra || {});
      const focusable = 'input,textarea,select,button,a[href],[contenteditable=""],[contenteditable="true"],[tabindex]';
      window.__pbInput = (m) => {
        const el = (m.x != null) ? document.elementFromPoint(m.x, m.y) : null;
        switch (m.e) {
          case 'click': {
            if (!el) return;
            el.dispatchEvent(new PointerEvent('pointerdown', opts(m, { pointerType: 'mouse', isPrimary: true })));
            el.dispatchEvent(new MouseEvent('mousedown', opts(m)));
            const f = el.closest(focusable);
            if (f && f.focus) f.focus();
            if (f && typeof f.setSelectionRange === 'function' && typeof f.value === 'string') { try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} }
            el.dispatchEvent(new PointerEvent('pointerup', opts(m, { pointerType: 'mouse', isPrimary: true })));
            el.dispatchEvent(new MouseEvent('mouseup', opts(m)));
            el.click();
            return;
          }
          case 'move':
            if (el) { el.dispatchEvent(new MouseEvent('mouseover', opts(m))); el.dispatchEvent(new MouseEvent('mousemove', opts(m))); }
            return;
          case 'wheel': {
            for (let t = el; t && t !== document.body && t !== document.documentElement; t = t.parentElement) {
              const cs = getComputedStyle(t);
              if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (t.scrollHeight > t.clientHeight || t.scrollWidth > t.clientWidth)) { t.scrollBy(m.dx, m.dy); return; }
            }
            window.scrollBy(m.dx, m.dy);
            return;
          }
          case 'text': {
            const a = document.activeElement;
            if (!a || a === document.body) return;
            if (!document.execCommand('insertText', false, m.text) && typeof a.value === 'string') {
              a.value += m.text;
              a.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return;
          }
          case 'key': {
            const a = document.activeElement || document.body;
            const k = { key: m.key, code: m.code || '', bubbles: true, cancelable: true, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta };
            if (a.dispatchEvent(new KeyboardEvent('keydown', k))) {
              const editable = a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName);
              if (m.key === 'Backspace') document.execCommand('delete');
              else if (m.key === 'Delete') document.execCommand('forwardDelete');
              else if (m.key === 'Enter') {
                if (a.tagName === 'TEXTAREA' || a.isContentEditable) document.execCommand('insertLineBreak');
                else if (a.form) { if (a.form.requestSubmit) a.form.requestSubmit(); else a.form.submit(); }
                else if (a.click && a !== document.body) a.click();
              } else if (m.key === 'Tab') {
                const all = [...document.querySelectorAll(focusable)].filter((n) => n.tabIndex >= 0 && !n.disabled && n.offsetParent !== null);
                const i = all.indexOf(a);
                const next = all[(i + (m.shift ? all.length - 1 : 1)) % all.length];
                if (next) next.focus();
              } else if ((m.ctrl || m.meta) && m.key.toLowerCase() === 'a') document.execCommand('selectAll');
              else if (!editable) {
                const d = { ArrowDown: 40, ArrowUp: -40, PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9, Home: -1e9, End: 1e9, ' ': innerHeight * 0.9 }[m.key];
                if (d) window.scrollBy(0, d);
              }
            }
            a.dispatchEvent(new KeyboardEvent('keyup', k));
            return;
          }
        }
      };
    })();
    """
}

/// Hosts the renderer's web view, scaled to fit. WKWebView only paints while it's in a visible
/// window, so the dashboard shows this preview whenever the Chromebook uses "iPhone renders".
struct RemotePreview: UIViewRepresentable {
    @ObservedObject var renderer: RemoteRenderer

    func makeUIView(context: Context) -> PreviewHost { PreviewHost(webView: renderer.webView) }
    func updateUIView(_ v: PreviewHost, context: Context) {
        v.contentSize = renderer.viewSize
        v.setNeedsLayout()
    }

    final class PreviewHost: UIView {
        let webView: WKWebView
        var contentSize = CGSize(width: 1280, height: 720)
        init(webView: WKWebView) {
            self.webView = webView
            super.init(frame: .zero)
            clipsToBounds = true
            addSubview(webView)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
        override func layoutSubviews() {
            super.layoutSubviews()
            if webView.superview !== self { addSubview(webView) }
            let s = bounds.width / max(contentSize.width, 1)
            webView.transform = CGAffineTransform(scaleX: s, y: s)
            webView.bounds = CGRect(origin: .zero, size: contentSize)
            webView.center = CGPoint(x: contentSize.width * s / 2, y: contentSize.height * s / 2)
        }
    }
}
