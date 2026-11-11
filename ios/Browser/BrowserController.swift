import Foundation
import WebKit

/// Owns the single WKWebView that is the "computer". All website networking, cookies and
/// script execution happen here, on the iPhone.
final class BrowserController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    /// Desktop CSS viewport. The Chromebook sees a scaled render of this.
    static let viewport = CGSize(width: 1280, height: 800)

    let webView: WKWebView

    @Published private(set) var url: String = ""
    @Published private(set) var title: String = ""
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0

    var homepage = "https://www.google.com"
    var searchTemplate = "https://www.google.com/search?q=%s"

    /// Fired (coalesced) when navigation state changes.
    var onStateChange: (() -> Void)?
    /// Fired when page content likely changed (load events) — hint for the frame streamer.
    var onContentHint: (() -> Void)?

    private var observations: [NSKeyValueObservation] = []
    private var stateScheduled = false

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                      // persistent cookies + storage
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        config.allowsInlineMediaPlayback = true
        config.userContentController.addUserScript(
            WKUserScript(source: InputAgent.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: CGRect(origin: .zero, size: Self.viewport), configuration: config)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.customUserAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = true
        webView.backgroundColor = .white
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        observations = [
            webView.observe(\.url) { [weak self] _, _ in self?.refreshState() },
            webView.observe(\.title) { [weak self] _, _ in self?.refreshState() },
            webView.observe(\.canGoBack) { [weak self] _, _ in self?.refreshState() },
            webView.observe(\.canGoForward) { [weak self] _, _ in self?.refreshState() },
            webView.observe(\.isLoading) { [weak self] _, _ in self?.refreshState() },
            webView.observe(\.estimatedProgress) { [weak self] _, _ in self?.refreshState() },
        ]
    }

    // MARK: - Navigation

    func navigate(_ input: String) {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, let url = Self.resolve(s, searchTemplate: searchTemplate) else { return }
        webView.load(URLRequest(url: url))
    }

    func goHome() { navigate(homepage) }

    static func resolve(_ s: String, searchTemplate: String) -> URL? {
        var url: URL?
        if s.contains("://") {
            url = URL(string: s)
        } else if !s.contains(" "), s.contains(".") || s.hasPrefix("localhost") {
            url = URL(string: "https://" + s)
        }
        if url == nil || url?.host == nil {
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "&+=?#")
            let q = s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
            url = URL(string: searchTemplate.replacingOccurrences(of: "%s", with: q))
        }
        guard let u = url, let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return u
    }

    func perform(_ action: String) {
        switch action {
        case "back": webView.goBack()
        case "forward": webView.goForward()
        case "reload": webView.reload()
        case "stop": webView.stopLoading()
        case "home": goHome()
        default: break
        }
    }

    // MARK: - Input (coordinates are 0–1 fractions of the viewport)

    func pointer(_ action: String, nx: Double, ny: Double, button: Int) {
        let p = point(nx, ny)
        call("__pb.pointer(a, x, y, b)", ["a": action, "x": Double(p.x), "y": Double(p.y), "b": button])
    }

    func wheel(nx: Double, ny: Double, dx: Double, dy: Double) {
        let p = point(nx, ny)
        call("__pb.wheel(x, y, dx, dy)", ["x": Double(p.x), "y": Double(p.y), "dx": dx, "dy": dy])
    }

    func text(_ s: String) {
        call("__pb.text(s)", ["s": s])
    }

    func key(_ key: String, ctrl: Bool, alt: Bool, shift: Bool, meta: Bool) {
        call("__pb.key(k, m)", ["k": key, "m": ["ctrl": ctrl, "alt": alt, "shift": shift, "meta": meta]])
    }

    private func point(_ nx: Double, _ ny: Double) -> CGPoint {
        CGPoint(x: min(max(nx, 0), 1) * Self.viewport.width, y: min(max(ny, 0), 1) * Self.viewport.height)
    }

    private func call(_ body: String, _ args: [String: Any]) {
        webView.callAsyncJavaScript("if (window.__pb) { \(body); }", arguments: args, in: nil, in: .page,
                                    completionHandler: nil)
    }

    // MARK: - Data

    func clearWebsiteData(completion: @escaping () -> Void) {
        let store = webView.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: completion)
    }

    // MARK: - State

    private func refreshState() {
        url = webView.url?.absoluteString ?? ""
        title = webView.title ?? ""
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
        isLoading = webView.isLoading
        progress = webView.estimatedProgress
        guard !stateScheduled else { return }
        stateScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.stateScheduled = false
            self?.onStateChange?()
        }
    }

    var stateMessage: [String: Any] {
        ["t": "state", "url": url, "title": title, "canGoBack": canGoBack, "canGoForward": canGoForward,
         "loading": isLoading, "progress": progress]
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { onContentHint?() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onContentHint?() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { refreshState() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        refreshState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// target=_blank / window.open: single-tab MVP opens in place.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}
