import SwiftUI
import WebKit

/// Keeps the 1280×800 web view in the window (WebKit stops rendering detached views)
/// and shows it scaled down as a live, touchable preview on the dashboard.
struct WebPreview: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> Container { Container(webView: webView) }
    func updateUIView(_ uiView: Container, context: Context) {
        if webView.superview !== uiView { uiView.adopt(webView) }
    }

    final class Container: UIView {
        private(set) var webView: WKWebView

        init(webView: WKWebView) {
            self.webView = webView
            super.init(frame: .zero)
            clipsToBounds = true
            backgroundColor = .black
            adopt(webView)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        func adopt(_ view: WKWebView) {
            webView = view
            addSubview(view)
            setNeedsLayout()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            let size = BrowserController.viewport
            guard bounds.width > 0 else { return }
            let s = min(bounds.width / size.width, bounds.height / size.height)
            webView.transform = .identity
            webView.bounds = CGRect(origin: .zero, size: size)
            webView.transform = CGAffineTransform(scaleX: s, y: s)
            webView.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
    }
}
