import Foundation
import UIKit
import PhoneBridgeCore

/// "iPhone fetches" mode (opt-in on the Chromebook). The Chromebook sends whole HTTP requests;
/// the iPhone performs them with URLSession, so TLS handshakes and connection reuse happen on its
/// own fast connection instead of across Bluetooth. For a page (`nav`), the iPhone also scans the
/// HTML and fetches the page's stylesheets, scripts and first images at once, pushing them before
/// the Chromebook asks. Text goes deflate-compressed; with Data saver, big images are shrunk.
///
/// The Chromebook still parses, runs and draws everything, keeps the cookies (the iPhone stores
/// none) and its own cache. In this mode the iPhone necessarily sees the pages.
final class FetchProxy: NSObject, URLSessionTaskDelegate {
    static let frameData = 2048
    static let maxBody = 60 * 1024 * 1024
    static let maxPushes = 40
    static let maxImagePushes = 12

    var onReady: () -> Void = {}
    var sendControl: ([String: Any]) -> Void = { _ in }
    private(set) var bytesSent = 0

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = nil              // cookies live on the Chromebook
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 256 << 20)
        c.httpMaximumConnectionsPerHost = 8
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c, delegate: self, delegateQueue: .main)
    }()

    private struct Fetched { let status: Int; let headers: [[String]]; let body: Data; let url: String }

    private final class Job {
        let id: UInt32
        var frames: [Data] = []
        var recent = 0.0
        var recentAt = CFAbsoluteTimeGetCurrent()
        var task: URLSessionTask?
        init(id: UInt32) { self.id = id }
    }
    private final class Push {
        let cls: Int            // 0: blocks drawing (stylesheet, script); 1: image
        var frames: [Data] = []
        var done = false
        var task: URLSessionTask?
        init(cls: Int) { self.cls = cls }
    }
    private var requested: [UInt32: Job] = [:]
    private var pushes: [Push] = []
    private var pushSeq: UInt32 = 0x8000_0000

    // MARK: - Commands

    func handle(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "fx": start(m)
        case "fx_cancel":
            if let id = (m["id"] as? NSNumber)?.uint32Value, let j = requested.removeValue(forKey: id) { j.task?.cancel() }
        default: break
        }
    }

    func reset() {
        for j in requested.values { j.task?.cancel() }
        for p in pushes { p.task?.cancel() }
        requested.removeAll()
        pushes.removeAll()
    }

    private static let dropRequest: Set<String> = ["host", "content-length", "connection", "keep-alive", "accept-encoding",
                                                   "transfer-encoding", "upgrade", "te", "proxy-connection", "trailer"]

    private func start(_ m: [String: Any]) {
        guard let id = (m["id"] as? NSNumber)?.uint32Value else { return }
        let job = Job(id: id)
        requested[id] = job
        guard let s = m["url"] as? String, let url = URL(string: s), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return finish(job, Self.errorFrames(id, code: "Unsupported", title: "Unsupported address", message: "Only web addresses can be fetched.", push: nil))
        }
        var req = URLRequest(url: url)
        req.httpMethod = (m["method"] as? String) ?? "GET"
        var conditional = false
        for pair in (m["headers"] as? [[String]]) ?? [] where pair.count == 2 {
            let n = pair[0].lowercased()
            if Self.dropRequest.contains(n) { continue }
            if n == "if-none-match" || n == "if-modified-since" { conditional = true }
            req.addValue(pair[1], forHTTPHeaderField: pair[0])
        }
        if let b = m["body"] as? String { req.httpBody = Data(base64Encoded: b) }
        // The Chromebook revalidates its own cache: let its 304s through instead of answering locally.
        if conditional { req.cachePolicy = .reloadIgnoringLocalCacheData }
        let save = (m["save"] as? Bool) ?? false
        let nav = (m["nav"] as? Bool) ?? false
        job.task = run(req) { [weak self, weak job] result in
            guard let self, let job, self.requested[job.id] === job else { return }
            switch result {
            case .success(let r):
                self.finish(job, self.frames(job.id, r, save: save, push: nil))
                if nav { self.pushSubresources(of: r, request: req, save: save) }
            case .failure(let e):
                self.finish(job, Self.errorFrames(job.id, e, push: nil))
            }
        }
    }

    private func finish(_ job: Job, _ frames: [Data]) {
        job.frames = frames
        onReady()
    }

    // MARK: - HTTP

    private func run(_ req: URLRequest, done: @escaping (Result<Fetched, Error>) -> Void) -> URLSessionTask {
        let task = session.dataTask(with: req) { data, response, error in
            if let error { return done(.failure(error)) }
            guard let http = response as? HTTPURLResponse else { return done(.failure(URLError(.badServerResponse))) }
            let body = data ?? Data()
            if body.count > Self.maxBody { return done(.failure(URLError(.dataLengthExceedsMaximum))) }
            done(.success(Fetched(status: http.statusCode, headers: Self.headers(http), body: body, url: req.url?.absoluteString ?? "")))
        }
        task.resume()
        return task
    }

    /// Redirects go back to the Chromebook, which applies its cookies and HSTS to the next hop.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// URLSession has already decoded the body, and folds repeated headers together. Set-Cookie
    /// is rebuilt one cookie per header so the Chromebook's cookie jar can read it.
    private static func headers(_ http: HTTPURLResponse) -> [[String]] {
        var out: [[String]] = []
        var fields: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            guard let name = k as? String, let value = v as? String else { continue }
            fields[name] = value
            switch name.lowercased() {
            case "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie": continue
            default: out.append([name, value])
            }
        }
        if let url = http.url {
            for c in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) {
                var line = "\(c.name)=\(c.value); Path=\(c.path)"
                if c.domain.hasPrefix(".") { line += "; Domain=\(c.domain)" }
                if let d = c.expiresDate { line += "; Max-Age=\(max(0, Int(d.timeIntervalSinceNow)))" }
                if c.isSecure { line += "; Secure" }
                if c.isHTTPOnly { line += "; HttpOnly" }
                out.append(["Set-Cookie", line])
            }
        }
        return out
    }

    // MARK: - Frames

    private func frames(_ id: UInt32, _ r: Fetched, save: Bool, push: String?) -> [Data] {
        var headers = r.headers
        var body = r.body
        let ct = headers.first { $0[0].lowercased() == "content-type" }?[1].lowercased() ?? ""
        var enc: String?
        if save, let smaller = Self.shrinkImage(body, type: ct) {
            body = smaller.data
            headers = headers.filter { $0[0].lowercased() != "content-type" } + [["Content-Type", smaller.type]]
        } else if body.count > 1024, ct.range(of: "text|json|javascript|xml|svg", options: .regularExpression) != nil,
                  let z = try? (body as NSData).compressed(using: .zlib) as Data, z.count < body.count {
            body = z          // raw DEFLATE; the Chromebook inflates with DecompressionStream('deflate-raw')
            enc = "deflate-raw"
        }
        var head: [String: Any] = ["status": r.status, "statusText": HTTPURLResponse.localizedString(forStatusCode: r.status),
                                   "headers": headers, "url": r.url]
        if let enc { head["enc"] = enc }
        if let push { head["push"] = push }
        var out = [Self.frame(.head, id, (try? JSONSerialization.data(withJSONObject: head)) ?? Data())]
        var o = body.startIndex
        while o < body.endIndex {
            let end = min(o + Self.frameData, body.endIndex)
            out.append(Self.frame(.data, id, body.subdata(in: o..<end)))
            o = end
        }
        out.append(Self.frame(.end, id, Data()))
        return out
    }

    /// Data saver: images over 40 KB are scaled to at most 1600 px and re-encoded, if that's smaller.
    private static func shrinkImage(_ data: Data, type: String) -> (data: Data, type: String)? {
        guard data.count > 40_000, type.range(of: "image/(jpeg|jpg|png|webp|heic)", options: .regularExpression) != nil,
              let img = UIImage(data: data) else { return nil }
        let px = CGSize(width: img.size.width * img.scale, height: img.size.height * img.scale)
        let k = min(1, 1600 / max(px.width, px.height, 1))
        let size = CGSize(width: (px.width * k).rounded(), height: (px.height * k).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let alpha = img.cgImage.map { ![CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast].contains($0.alphaInfo) } ?? false
        format.opaque = !alpha
        let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        let out = alpha ? scaled.pngData() : scaled.jpegData(compressionQuality: 0.6)
        guard let out, out.count < data.count * 9 / 10 else { return nil }
        return (out, alpha ? "image/png" : "image/jpeg")
    }

    enum Kind: UInt8 { case head = 1, data = 2, end = 3, error = 4 }

    /// 0x06 | u8 kind | u32 id | payload
    static func frame(_ kind: Kind, _ id: UInt32, _ payload: Data) -> Data {
        var d = Data([PBWire.Inner.fetch.rawValue, kind.rawValue])
        d.appendBE(id)
        d.append(payload)
        return d
    }

    static func errorFrames(_ id: UInt32, _ error: Error, push: String?) -> [Data] {
        let e = error as? URLError
        let host = e?.failingURL?.host ?? "the site"
        switch e?.code {
        case .cannotFindHost?, .dnsLookupFailed?:
            return errorFrames(id, code: "NameNotResolved", title: "Site not found", message: "The iPhone couldn’t find \(host).", push: push)
        case .cannotConnectToHost?:
            return errorFrames(id, code: "ConnectionRefused", title: "Connection refused", message: "\(host) refused the connection.", push: push)
        case .timedOut?:
            return errorFrames(id, code: "TimedOut", title: "Timed out", message: "\(host) took too long to respond.", push: push)
        case .notConnectedToInternet?, .networkConnectionLost?, .dataNotAllowed?, .internationalRoamingOff?:
            return errorFrames(id, code: "InternetDisconnected", title: "No internet on the iPhone", message: "The iPhone has no internet connection right now.", push: push)
        case .secureConnectionFailed?, .serverCertificateUntrusted?, .serverCertificateHasBadDate?, .serverCertificateNotYetValid?,
             .serverCertificateHasUnknownRoot?, .clientCertificateRejected?, .appTransportSecurityRequiresSecureConnection?:
            return errorFrames(id, code: "ConnectionFailed", title: "Secure connection failed", message: "Secure connection to \(host) failed (\(error.localizedDescription)).", push: push)
        default:
            return errorFrames(id, code: "ConnectionFailed", title: "Couldn’t load the page", message: error.localizedDescription, push: push)
        }
    }

    static func errorFrames(_ id: UInt32, code: String, title: String, message: String, push: String?) -> [Data] {
        var out: [Data] = []
        if let push { out.append(frame(.head, id, (try? JSONSerialization.data(withJSONObject: ["push": push])) ?? Data())) }
        out.append(frame(.error, id, (try? JSONSerialization.data(withJSONObject: ["code": code, "title": title, "message": message])) ?? Data()))
        return out
    }

    // MARK: - Push

    private func pushSubresources(of r: Fetched, request: URLRequest, save: Bool) {
        let ct = r.headers.first { $0[0].lowercased() == "content-type" }?[1] ?? ""
        guard ct.lowercased().contains("html"), r.body.count < 4 << 20, let page = URL(string: r.url) else { return }
        let html = String(decoding: r.body, as: UTF8.self)
        let found = Self.subresources(html, base: page)
        guard !found.isEmpty else { return }
        sendControl(["t": "fx_promise", "urls": found.map { $0.url.absoluteString }])
        let cookie = request.value(forHTTPHeaderField: "Cookie")
        let agent = request.value(forHTTPHeaderField: "User-Agent")
        for f in found {
            let p = Push(cls: f.cls)
            let id = pushSeq
            pushSeq = pushSeq == UInt32.max ? 0x8000_0000 : pushSeq + 1
            pushes.append(p)
            var req = URLRequest(url: f.url)
            req.setValue("*/*", forHTTPHeaderField: "Accept")
            req.setValue(page.absoluteString, forHTTPHeaderField: "Referer")
            if let agent { req.setValue(agent, forHTTPHeaderField: "User-Agent") }
            if let cookie, f.url.host == page.host { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
            let url = f.url.absoluteString
            p.task = run(req) { [weak self, weak p] result in
                guard let self, let p else { return }
                switch result {
                case .success(let r): p.frames = self.frames(id, r, save: save, push: url)
                case .failure(let e): p.frames = Self.errorFrames(id, e, push: url)
                }
                p.done = true
                self.onReady()
            }
        }
    }

    /// Stylesheets and scripts first (they block drawing), then the first images. A plain scan, not a
    /// parser: anything missed is simply fetched when the Chromebook asks for it.
    static func subresources(_ html: String, base page: URL) -> [(url: URL, cls: Int)] {
        var base = page
        if let b = firstMatch(#"<base\b[^>]*\bhref=["']?([^"'\s>]+)"#, html), let u = URL(string: b, relativeTo: page) { base = u.absoluteURL }
        var out: [(url: URL, cls: Int)] = []
        func add(_ s: String, _ cls: Int) {
            let t = s.replacingOccurrences(of: "&amp;", with: "&")
            guard out.count < maxPushes, !t.hasPrefix("data:"), let u = URL(string: t, relativeTo: base)?.absoluteURL,
                  let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  !out.contains(where: { $0.url == u }) else { return }
            out.append((u, cls))
        }
        for tag in allMatches(#"<link\b[^>]*>"#, html, group: 0) where tag.range(of: #"rel=["']?[^"'>]*stylesheet"#, options: [.regularExpression, .caseInsensitive]) != nil {
            if let h = firstMatch(#"href=["']?([^"'\s>]+)"#, tag) { add(h, 0) }
        }
        for s in allMatches(#"<script\b[^>]*\bsrc=["']?([^"'\s>]+)"#, html, group: 1) { add(s, 0) }
        for s in allMatches(#"<img\b[^>]*\bsrc=["']?([^"'\s>]+)"#, html, group: 1).prefix(maxImagePushes) { add(s, 1) }
        return out
    }

    private static func allMatches(_ pattern: String, _ s: String, group: Int) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { m in
            Range(m.range(at: group), in: s).map { String(s[$0]) }
        }
    }
    private static func firstMatch(_ pattern: String, _ s: String) -> String? { allMatches(pattern, s, group: 1).first }

    // MARK: - Outgoing

    /// Responses the Chromebook is waiting for come first (least recently served first); then
    /// pushes in page order, but no image while a stylesheet or script is still pending.
    func nextFrame() -> Data? {
        let now = CFAbsoluteTimeGetCurrent()
        var best: Job?
        for j in requested.values where !j.frames.isEmpty {
            j.recent *= pow(0.5, now - j.recentAt)
            j.recentAt = now
            if best == nil || j.recent < best!.recent { best = j }
        }
        if let j = best {
            let f = j.frames.removeFirst()
            j.recent += Double(f.count)
            if j.frames.isEmpty, j.task?.state != .running { requested.removeValue(forKey: j.id) }
            bytesSent += f.count
            return f
        }
        pushes.removeAll { $0.done && $0.frames.isEmpty }
        let blocking = pushes.contains { $0.cls == 0 }
        guard let p = pushes.first(where: { !$0.frames.isEmpty && (!blocking || $0.cls == 0) }) else { return nil }
        let f = p.frames.removeFirst()
        bytesSent += f.count
        return f
    }
}
