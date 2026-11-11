import Foundation
import CommonCrypto

/// PBKDF2-HMAC-SHA256 verifier for the optional persistent unlock password.
/// Only the verifier is stored (Keychain); the password itself never is.
public struct PasswordVerifier: Codable, Equatable {
    public var salt: Data
    public var iterations: Int
    public var hash: Data

    public static let defaultIterations = 210_000

    public static func make(password: String, iterations: Int = defaultIterations) -> PasswordVerifier {
        let salt = PBCrypto.randomBytes(16)
        return PasswordVerifier(salt: salt, iterations: iterations,
                                hash: pbkdf2(password: password, salt: salt, iterations: iterations))
    }

    public func verify(_ password: String) -> Bool {
        PBCrypto.constantTimeEqual(Self.pbkdf2(password: password, salt: salt, iterations: iterations), hash)
    }

    public static func pbkdf2(password: String, salt: Data, iterations: Int, length: Int = 32) -> Data {
        var out = Data(count: length)
        let pw = Array(password.utf8)
        let status: Int32 = out.withUnsafeMutableBytes { outPtr in
            salt.withUnsafeBytes { saltPtr in
                pw.withUnsafeBufferPointer { pwPtr in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwPtr.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) },
                        pw.count,
                        saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                        outPtr.bindMemory(to: UInt8.self).baseAddress, length)
                }
            }
        }
        precondition(status == Int32(kCCSuccess), "PBKDF2 failed: \(status)")
        return out
    }
}
