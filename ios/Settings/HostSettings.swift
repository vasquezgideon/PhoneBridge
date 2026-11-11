import Foundation

struct DisplaySettings: Codable, Equatable {
    var quality: Double = 0.5     // JPEG quality 0.1–0.95
    var scale: Double = 0.75      // fraction of the 1280×800 viewport sent to the Chromebook
    var fps: Double = 2           // idle capture rate; input triggers short 10 fps bursts
    var grayscale = false
    var tiles = true              // changed-region updates

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = DisplaySettings()
        quality = try c.decodeIfPresent(Double.self, forKey: .quality) ?? d.quality
        scale = try c.decodeIfPresent(Double.self, forKey: .scale) ?? d.scale
        fps = try c.decodeIfPresent(Double.self, forKey: .fps) ?? d.fps
        grayscale = try c.decodeIfPresent(Bool.self, forKey: .grayscale) ?? d.grayscale
        tiles = try c.decodeIfPresent(Bool.self, forKey: .tiles) ?? d.tiles
    }

    /// Applies a partial update from a `display` control message, clamped to sane ranges.
    mutating func apply(_ m: [String: Any]) {
        if let v = m["quality"] as? Double { quality = min(max(v, 0.1), 0.95) }
        if let v = m["scale"] as? Double { scale = min(max(v, 0.25), 1) }
        if let v = m["fps"] as? Double { fps = min(max(v, 0.2), 10) }
        if let v = m["grayscale"] as? Bool { grayscale = v }
        if let v = m["tiles"] as? Bool { tiles = v }
    }

    var message: [String: Any] {
        ["t": "display", "quality": quality, "scale": scale, "fps": fps, "grayscale": grayscale, "tiles": tiles]
    }
}

struct HostSettings: Codable, Equatable {
    var hostName = "iPhone"
    var homepage = "https://www.google.com"
    var searchTemplate = "https://www.google.com/search?q=%s"
    var requirePasswordEveryReconnect = false
    var keepScreenAwake = true
    var display = DisplaySettings()

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = HostSettings()
        hostName = try c.decodeIfPresent(String.self, forKey: .hostName) ?? d.hostName
        homepage = try c.decodeIfPresent(String.self, forKey: .homepage) ?? d.homepage
        searchTemplate = try c.decodeIfPresent(String.self, forKey: .searchTemplate) ?? d.searchTemplate
        requirePasswordEveryReconnect = try c.decodeIfPresent(Bool.self, forKey: .requirePasswordEveryReconnect)
            ?? d.requirePasswordEveryReconnect
        keepScreenAwake = try c.decodeIfPresent(Bool.self, forKey: .keepScreenAwake) ?? d.keepScreenAwake
        display = try c.decodeIfPresent(DisplaySettings.self, forKey: .display) ?? d.display
    }

    private static let key = "app.phonebridge.settings.v1"

    static func load() -> HostSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(HostSettings.self, from: data) else { return HostSettings() }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
