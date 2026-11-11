import Foundation
import Security
import PhoneBridgeCore

/// Generic-password Keychain items, this-device-only, readable after first unlock.
enum Keychain {
    static let service = "app.phonebridge.host"

    static func read(_ account: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    @discardableResult
    static func write(_ account: String, _ data: Data) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecSuccess { return true }
        return SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}

/// Trusted Chromebooks, the optional persistent password, and brute-force lockout.
final class SecurityStore {
    private(set) var devices: [TrustedDevice] = []
    private(set) var verifier: PasswordVerifier?
    let phoneId: Data

    private var failedPasswordAttempts = 0
    private var lockedUntil = Date.distantPast

    init() {
        if let d = Keychain.read("devices"), let list = try? JSONDecoder().decode([TrustedDevice].self, from: d) {
            devices = list
        }
        if let v = Keychain.read("password"), let pv = try? JSONDecoder().decode(PasswordVerifier.self, from: v) {
            verifier = pv
        }
        if let id = Keychain.read("phoneId"), id.count == 16 {
            phoneId = id
        } else {
            phoneId = PBCrypto.randomBytes(16)
            Keychain.write("phoneId", phoneId)
        }
    }

    var passwordSet: Bool { verifier != nil }

    func device(id: String) -> TrustedDevice? { devices.first { $0.id == id } }

    func upsert(_ device: TrustedDevice) {
        devices.removeAll { $0.id == device.id }
        devices.append(device)
        saveDevices()
    }

    func remove(id: String) {
        devices.removeAll { $0.id == id }
        saveDevices()
    }

    func touch(id: String) {
        guard let i = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[i].lastSeen = Date()
        saveDevices()
    }

    func setRemembered(id: String, _ value: Bool) {
        guard let i = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[i].passwordRemembered = value
        saveDevices()
    }

    /// Changing the password revokes "remember this device" everywhere except `keep`.
    func setPassword(_ password: String?, keepRememberedFor keep: String? = nil) {
        if let password {
            verifier = PasswordVerifier.make(password: password)
            if let data = try? JSONEncoder().encode(verifier) { Keychain.write("password", data) }
        } else {
            verifier = nil
            Keychain.delete("password")
        }
        for i in devices.indices where devices[i].id != keep { devices[i].passwordRemembered = false }
        saveDevices()
        failedPasswordAttempts = 0
        lockedUntil = .distantPast
    }

    var lockoutRemaining: TimeInterval { max(0, lockedUntil.timeIntervalSinceNow) }

    enum PasswordCheck { case ok, wrong(lockout: TimeInterval), lockedOut(TimeInterval), notSet }

    /// 5 free attempts, then exponential lockout: 30 s, 60 s, … capped at 15 min.
    func checkPassword(_ password: String) -> PasswordCheck {
        guard let verifier else { return .notSet }
        let remaining = lockoutRemaining
        if remaining > 0 { return .lockedOut(remaining) }
        if verifier.verify(password) {
            failedPasswordAttempts = 0
            return .ok
        }
        failedPasswordAttempts += 1
        if failedPasswordAttempts >= 5 {
            let secs = min(30 * pow(2, Double(failedPasswordAttempts - 5)), 900)
            lockedUntil = Date().addingTimeInterval(secs)
            return .wrong(lockout: secs)
        }
        return .wrong(lockout: 0)
    }

    func factoryReset() {
        devices = []
        verifier = nil
        Keychain.delete("devices")
        Keychain.delete("password")
        failedPasswordAttempts = 0
        lockedUntil = .distantPast
    }

    private func saveDevices() {
        if let data = try? JSONEncoder().encode(devices) { Keychain.write("devices", data) }
    }
}
