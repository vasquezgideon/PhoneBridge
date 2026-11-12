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
}

/// The one universal password. Kept in the Keychain (it's shown in the app, so it is stored,
/// not hashed). The X25519 base point derived from it is cached.
final class PasswordStore {
    private(set) var password: String
    private(set) var generator: Data
    static let minLength = 4

    init() {
        if let d = Keychain.read("password"), let s = String(data: d, encoding: .utf8), s.count >= Self.minLength {
            password = s
        } else {
            password = Self.random()
            Keychain.write("password", Data(password.utf8))
        }
        generator = PBCrypto.generator(password: password)
    }

    func set(_ new: String) {
        password = new
        generator = PBCrypto.generator(password: new)
        Keychain.write("password", Data(new.utf8))
    }

    /// e.g. "k7mq-3xph" — 8 chars from 31 unambiguous symbols ≈ 40 bits.
    static func random() -> String {
        let alphabet = Array("abcdefghjkmnpqrstuvwxyz23456789")
        let chars = (0..<8).map { _ in alphabet.randomElement()! }
        return String(chars[0..<4]) + "-" + String(chars[4..<8])
    }
}
