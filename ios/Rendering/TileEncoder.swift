import Foundation
import CoreGraphics
import ImageIO
import PhoneBridgeCore

/// Raster of the last frame sent, used for changed-region detection.
struct FrameState {
    var pixels: [UInt8]
    var width: Int
    var height: Int
    var bytesPerPixel: Int
    var bytesPerRow: Int
}

/// Converts a snapshot into JPEG tiles. Only regions that changed since `previous` are sent;
/// horizontal runs of changed tiles are merged, and if most of the frame changed it is sent whole.
enum TileEncoder {
    struct Result {
        var tiles: [Data]
        var state: FrameState?
    }

    static func encode(image: CGImage, width w: Int, height h: Int, grayscale: Bool, quality: Double,
                       tileSize ts: Int, tilesEnabled: Bool, keyframe: Bool, previous: FrameState?,
                       frameId: UInt32) -> Result {
        let bpp = grayscale ? 1 : 4
        let space = grayscale ? CGColorSpaceCreateDeviceGray() : (CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB())
        let info = grayscale ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * bpp,
                                  space: space, bitmapInfo: info) else { return Result(tiles: [], state: nil) }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let raw = ctx.data, let frame = ctx.makeImage() else { return Result(tiles: [], state: nil) }
        let bpr = ctx.bytesPerRow
        let pixels = Array(UnsafeBufferPointer(start: raw.assumingMemoryBound(to: UInt8.self), count: bpr * h))
        let state = FrameState(pixels: pixels, width: w, height: h, bytesPerPixel: bpp, bytesPerRow: bpr)

        let full = keyframe || !tilesEnabled || previous == nil ||
            previous!.width != w || previous!.height != h || previous!.bytesPerPixel != bpp || previous!.bytesPerRow != bpr

        var rects: [CGRect] = []
        if full {
            rects = [CGRect(x: 0, y: 0, width: w, height: h)]
        } else {
            let cols = (w + ts - 1) / ts, rows = (h + ts - 1) / ts
            var changed = [[Bool]](repeating: [Bool](repeating: false, count: cols), count: rows)
            var count = 0
            pixels.withUnsafeBufferPointer { cur in
                previous!.pixels.withUnsafeBufferPointer { old in
                    for r in 0..<rows {
                        for c in 0..<cols {
                            let x0 = c * ts, y0 = r * ts
                            let tw = min(ts, w - x0), th = min(ts, h - y0)
                            for y in y0..<(y0 + th) {
                                let off = y * bpr + x0 * bpp
                                if memcmp(cur.baseAddress! + off, old.baseAddress! + off, tw * bpp) != 0 {
                                    changed[r][c] = true
                                    count += 1
                                    break
                                }
                            }
                        }
                    }
                }
            }
            if count == 0 { return Result(tiles: [], state: state) }
            if count * 2 > rows * cols {
                rects = [CGRect(x: 0, y: 0, width: w, height: h)]
            } else {
                for r in 0..<rows {
                    var c = 0
                    while c < cols {
                        guard changed[r][c] else { c += 1; continue }
                        let start = c
                        while c < cols && changed[r][c] { c += 1 }
                        let x0 = start * ts, y0 = r * ts
                        rects.append(CGRect(x: x0, y: y0, width: min(c * ts, w) - x0, height: min(ts, h - y0)))
                    }
                }
            }
        }

        var tiles: [Data] = []
        for (i, rect) in rects.enumerated() {
            guard let crop = (rect.size == CGSize(width: w, height: h)) ? frame : frame.cropping(to: rect),
                  let jpeg = jpeg(crop, quality: quality) else { continue }
            var flags: UInt8 = full ? TileHeader.keyframe : 0
            if i == rects.count - 1 { flags |= TileHeader.endOfFrame }
            let header = TileHeader(frameId: frameId, fullWidth: UInt16(w), fullHeight: UInt16(h),
                                    x: UInt16(rect.minX), y: UInt16(rect.minY),
                                    width: UInt16(rect.width), height: UInt16(rect.height), flags: flags)
            tiles.append(header.encode(jpeg: jpeg))
        }
        return Result(tiles: tiles, state: tiles.isEmpty ? nil : state)
    }

    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
