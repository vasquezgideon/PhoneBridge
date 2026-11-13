import Foundation

struct HostSettings: Codable, Equatable {
    var hostName = "iPhone"
    var keepScreenAwake = true

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = HostSettings()
        hostName = try c.decodeIfPresent(String.self, forKey: .hostName) ?? d.hostName
        keepScreenAwake = try c.decodeIfPresent(Bool.self, forKey: .keepScreenAwake) ?? d.keepScreenAwake
    }

    private static let key = "app.phonebridge.settings.v3"

    static func load() -> HostSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(HostSettings.self, from: data) else { return HostSettings() }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
