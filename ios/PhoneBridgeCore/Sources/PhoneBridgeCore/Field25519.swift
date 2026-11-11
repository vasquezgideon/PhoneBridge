import Foundation

/// Arithmetic mod p = 2^255 − 19 on eight 32-bit little-endian limbs, plus the Elligator2 map
/// (RFC 9380 §6.7.1, Z = 2). Only used to turn the password into an X25519 base point, once per
/// password — clarity over speed. Mirrors the BigInt code in chromebook/extension/src/crypto.js;
/// both are pinned by protocol/test-vectors/handshake-v2.json.
public struct FieldElement: Equatable {
    public internal(set) var limbs: [UInt32]   // canonical: value < p

    static let pLimbs: [UInt32] = [0xffff_ffed] + Array(repeating: 0xffff_ffff, count: 6) + [0x7fff_ffff]
    static let pMinus2: [UInt32] = [0xffff_ffeb] + Array(repeating: 0xffff_ffff, count: 6) + [0x7fff_ffff]
    static let pMinus1Half: [UInt32] = [0xffff_fff6] + Array(repeating: 0xffff_ffff, count: 6) + [0x3fff_ffff]

    public static let zero = FieldElement(small: 0)
    public static let one = FieldElement(small: 1)
    static let montgomeryA = FieldElement(small: 486_662)

    init(canonical limbs: [UInt32]) { self.limbs = limbs }

    public init(small: UInt32) { limbs = [small] + Array(repeating: 0, count: 7) }

    /// Any 32 bytes (little-endian, full 256 bits) reduced mod p.
    public init(bytesLE b: Data) {
        precondition(b.count == 32)
        let d = Data(b)
        var wide = [UInt32](repeating: 0, count: 16)
        for i in 0..<8 {
            wide[i] = UInt32(d[4 * i]) | UInt32(d[4 * i + 1]) << 8 | UInt32(d[4 * i + 2]) << 16 | UInt32(d[4 * i + 3]) << 24
        }
        limbs = Self.reduceWide(wide)
    }

    public var bytesLE: Data {
        var out = Data(capacity: 32)
        for l in limbs { out.append(contentsOf: [UInt8(l & 0xff), UInt8((l >> 8) & 0xff), UInt8((l >> 16) & 0xff), UInt8(l >> 24)]) }
        return out
    }

    public var isZero: Bool { limbs.allSatisfy { $0 == 0 } }

    /// 16 limbs (any value < 2^512) → canonical 8 limbs, using 2^256 ≡ 38 (mod p).
    static func reduceWide(_ r: [UInt32]) -> [UInt32] {
        var s = [UInt32](repeating: 0, count: 8)
        var carry: UInt64 = 0
        for i in 0..<8 {
            let t = UInt64(r[i]) + UInt64(r[i + 8]) * 38 + carry
            s[i] = UInt32(truncatingIfNeeded: t)
            carry = t >> 32
        }
        while carry != 0 {
            var c = carry * 38
            for i in 0..<8 {
                let t = UInt64(s[i]) + c
                s[i] = UInt32(truncatingIfNeeded: t)
                c = t >> 32
            }
            carry = c
        }
        // Fold bit 255: 2^255 ≡ 19.
        let top = s[7] >> 31
        s[7] &= 0x7fff_ffff
        var c = UInt64(19 * top)
        for i in 0..<8 {
            let t = UInt64(s[i]) + c
            s[i] = UInt32(truncatingIfNeeded: t)
            c = t >> 32
        }
        // Now s < 2^255 + 19; subtract p if s ≥ p (i.e. s + 19 has bit 255 set).
        var t = [UInt32](repeating: 0, count: 8)
        c = 19
        for i in 0..<8 {
            let x = UInt64(s[i]) + c
            t[i] = UInt32(truncatingIfNeeded: x)
            c = x >> 32
        }
        if t[7] >> 31 == 1 {
            t[7] &= 0x7fff_ffff
            return t
        }
        return s
    }

    public static func * (a: FieldElement, b: FieldElement) -> FieldElement {
        var r = [UInt32](repeating: 0, count: 16)
        for i in 0..<8 {
            var carry: UInt64 = 0
            for j in 0..<8 {
                let t = UInt64(a.limbs[i]) * UInt64(b.limbs[j]) + UInt64(r[i + j]) + carry
                r[i + j] = UInt32(truncatingIfNeeded: t)
                carry = t >> 32
            }
            r[i + 8] = UInt32(truncatingIfNeeded: carry)
        }
        return FieldElement(canonical: reduceWide(r))
    }

    public static func + (a: FieldElement, b: FieldElement) -> FieldElement {
        var r = [UInt32](repeating: 0, count: 16)
        var carry: UInt64 = 0
        for i in 0..<8 {
            let t = UInt64(a.limbs[i]) + UInt64(b.limbs[i]) + carry
            r[i] = UInt32(truncatingIfNeeded: t)
            carry = t >> 32
        }
        r[8] = UInt32(truncatingIfNeeded: carry)
        return FieldElement(canonical: reduceWide(r))
    }

    public static prefix func - (b: FieldElement) -> FieldElement {
        var r = [UInt32](repeating: 0, count: 8)
        var borrow: Int64 = 0
        for i in 0..<8 {
            var t = Int64(pLimbs[i]) - Int64(b.limbs[i]) - borrow
            if t < 0 { t += 1 << 32; borrow = 1 } else { borrow = 0 }
            r[i] = UInt32(truncatingIfNeeded: t)
        }
        var wide = r
        wide.append(contentsOf: [UInt32](repeating: 0, count: 8))
        return FieldElement(canonical: reduceWide(wide))   // p − 0 = p → 0
    }

    public static func - (a: FieldElement, b: FieldElement) -> FieldElement { a + (-b) }

    func power(_ e: [UInt32]) -> FieldElement {
        var r = FieldElement.one
        for i in stride(from: 255, through: 0, by: -1) {
            r = r * r
            if (e[i / 32] >> UInt32(i % 32)) & 1 == 1 { r = r * self }
        }
        return r
    }

    public var inverse: FieldElement { power(Self.pMinus2) }

    public var isSquare: Bool {
        let l = power(Self.pMinus1Half)
        return l.isZero || l == .one
    }

    /// Elligator2 for Curve25519: returns the Montgomery u-coordinate.
    public static func elligator2(_ r: FieldElement) -> FieldElement {
        let tv1 = FieldElement(small: 2) * (r * r)
        let e = FieldElement.one + tv1
        let negA = -montgomeryA
        let x1 = e.isZero ? negA : negA * e.inverse
        let gx1 = x1 * x1 * x1 + montgomeryA * (x1 * x1) + x1
        return gx1.isSquare ? x1 : (-x1) - montgomeryA
    }
}
