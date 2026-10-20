// Renders the Android launcher icon from the iOS app's ios/Config/AppIcon-source.png, the "RS" rune stones of the 2004
// RuneScape logo on dark cobblestone (ports ios/scripts/make-icon.swift; docs/ANDROID.md §1 Identity, §4 "Shell: the
// launcher icon"). The source is painted art (340 × 340), not a game sprite, so it is scaled
// smoothly, never nearest-neighbour.
//
//   swift android/scripts/make-icon.swift [<source png>] [<res dir>]
//
// Defaults: ios/Config/AppIcon-source.png and android/app/src/main/res. Writes, for mdpi … xxxhdpi:
//   mipmap-*/ic_launcher_background.png   108 dp: the art at the foreground's size and place, mirrored outwards to fill
//                                         the layer (cobblestone only beyond the art: the art scaled to fill the
//                                         layer would show slices of its big stones at the edges), 15 % darker, and
//                                         darker still beyond the 72 dp the launcher shows
//   mipmap-*/ic_launcher_foreground.png   108 dp: the art at 72 dp, centred, its outer 6 dp fading out, so the stones
//                                         (about 55 × 44 dp) fit inside the 72 dp circle the roundest launcher mask
//                                         leaves (at 78 dp, the spec's first guess, a circle cut their outer edges)
//   mipmap-*/ic_launcher_monochrome.png   108 dp: the stones as a white mask at the foreground's scale, the carved letters
//                                         left out (Android 13's themed icons tint it; iOS's Tinted icon): the art
//                                         lighter than the cobblestone, small dark cracks filled, specks dropped
// plus mipmap-anydpi/ic_launcher.xml and ic_launcher_round.xml (the adaptive icon with its monochrome layer) and
// android/store/icon-512.png (512 × 512, opaque). No legacy 48 dp bitmaps: at minSdk 30 every launcher takes the
// adaptive icon, so they would never be used (and lint flags full-bleed ones, IconLauncherShape). Each file it writes is
// printed; any failure stops it.
import CoreGraphics
import Foundation
import ImageIO

let android = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let repo = android.deletingLastPathComponent()
let arguments = CommandLine.arguments.dropFirst()
let sourceURL = arguments.first.map { URL(fileURLWithPath: $0) } ?? repo.appendingPathComponent("ios/Config/AppIcon-source.png")
let resDir = arguments.dropFirst().first.map { URL(fileURLWithPath: $0) } ?? android.appendingPathComponent("app/src/main/res")
let storeDir = android.appendingPathComponent("store")

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let gray = CGColorSpaceCreateDeviceGray()

guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("cannot read \(sourceURL.path)")
}

/// The densities: folder and px per dp.
let densities: [(String, CGFloat)] = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]

/// Adaptive layers are 108 dp; the art spans 72 dp of it, its outer 6 dp feathered.
let layerDp: CGFloat = 108
let artDp: CGFloat = 72
let featherDp: CGFloat = 6
/// The stones are where the art is lighter than the cobblestone (luminance 0.06-0.14; the stones 0.15-0.8, the carved
/// letters 0); dark patches inside them smaller than `crackPx` are cracks (filled), light ones smaller than `speckPx`
/// specks of the cobblestone (dropped). The letters are far larger than either.
let stoneLuminance: CGFloat = 0.2
let crackPx = 400
let speckPx = 150

func context(_ size: Int, opaque: Bool) -> CGContext {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB, bitmapInfo: info) else {
        fatalError("cannot make a \(size) px context")
    }
    context.interpolationQuality = .high
    return context
}

func write(_ image: CGImage, to url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("cannot write \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("cannot write \(url.path)") }
    print("wrote \(url.path)")
}

func writeText(_ text: String, to url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
        try text.write(to: url, atomically: true, encoding: .utf8)
    } catch {
        fatalError("cannot write \(url.path): \(error)")
    }
    print("wrote \(url.path)")
}

/// A grey mask `size` px square from a function of the pixel centre (x, y in px, y down) → 0…1.
func mask(_ size: Int, _ value: (CGFloat, CGFloat) -> CGFloat) -> CGImage {
    var bytes = [UInt8](repeating: 0, count: size * size)
    for y in 0..<size {
        for x in 0..<size {
            let v = max(0, min(1, value(CGFloat(x) + 0.5, CGFloat(y) + 0.5)))
            bytes[y * size + x] = UInt8((v * 255).rounded())
        }
    }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size, space: gray,
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil,
                   shouldInterpolate: true, intent: .defaultIntent)!
}

func smoothstep(_ edge0: CGFloat, _ edge1: CGFloat, _ x: CGFloat) -> CGFloat {
    let t = max(0, min(1, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

// The stones' mask at the source's size: light pixels, the cracks filled and the specks dropped (connected regions by
// size, 4-neighbour), the edges softened by a 3 × 3 box blur.
let sourceSize = artwork.width
let rgba: [UInt8] = {
    let ctx = CGContext(data: nil, width: sourceSize, height: sourceSize, bitsPerComponent: 8, bytesPerRow: sourceSize * 4, space: sRGB,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(artwork, in: CGRect(x: 0, y: 0, width: sourceSize, height: sourceSize))
    let data = ctx.data!.bindMemory(to: UInt8.self, capacity: sourceSize * sourceSize * 4)
    return Array(UnsafeBufferPointer(start: data, count: sourceSize * sourceSize * 4))
}()
// (a bitmap context's memory and a mask's data both start with the top row, so the mask is drawn upright)
var stone = [Bool](repeating: false, count: sourceSize * sourceSize)
for i in 0..<(sourceSize * sourceSize) {
    let lum = (0.2126 * CGFloat(rgba[i * 4]) + 0.7152 * CGFloat(rgba[i * 4 + 1]) + 0.0722 * CGFloat(rgba[i * 4 + 2])) / 255
    stone[i] = lum > stoneLuminance
}
/// Flips every 4-connected region of `value` smaller than `limit` px that does not touch the border.
func flipSmall(_ value: Bool, _ limit: Int) {
    var seen = [Bool](repeating: false, count: stone.count)
    for start in 0..<stone.count where stone[start] == value && !seen[start] {
        var region = [start]
        var touchesBorder = false
        seen[start] = true
        var head = 0
        while head < region.count {
            let i = region[head]
            head += 1
            let x = i % sourceSize, y = i / sourceSize
            if x == 0 || y == 0 || x == sourceSize - 1 || y == sourceSize - 1 { touchesBorder = true }
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < sourceSize && ny < sourceSize {
                let n = ny * sourceSize + nx
                if stone[n] == value && !seen[n] {
                    seen[n] = true
                    region.append(n)
                }
            }
        }
        if !touchesBorder && region.count < limit {
            for i in region { stone[i] = !value }
        }
    }
}
flipSmall(false, crackPx) // cracks inside the stones
flipSmall(true, speckPx) // light specks in the cobblestone
let stonesMask = mask(sourceSize) { px, py in
    let x = Int(px), y = Int(py)
    var sum = 0
    for dy in -1...1 {
        for dx in -1...1 {
            let nx = min(max(x + dx, 0), sourceSize - 1), ny = min(max(y + dy, 0), sourceSize - 1)
            if stone[ny * sourceSize + nx] { sum += 1 }
        }
    }
    return CGFloat(sum) / 9
}

// ---------------------------------------------------------------------------------------------------- the layers

for (folder, scale) in densities {
    let size = Int((layerDp * scale).rounded())
    let art = artDp * scale
    let origin = (CGFloat(size) - art) / 2
    let artRect = CGRect(x: origin, y: origin, width: art, height: art)

    // background: the art where the foreground has it, mirrored outwards (a 3 × 3 of flipped copies), 15 % darker, and
    // up to 70 % darker in the margin beyond it, which a launcher shows only while it moves the layers
    let background = context(size, opaque: true)
    for row in -1...1 {
        for column in -1...1 {
            background.saveGState()
            let tile = artRect.offsetBy(dx: CGFloat(column) * art, dy: CGFloat(row) * art)
            background.translateBy(x: tile.midX, y: tile.midY)
            background.scaleBy(x: column == 0 ? 1 : -1, y: row == 0 ? 1 : -1)
            background.draw(artwork, in: CGRect(x: -art / 2, y: -art / 2, width: art, height: art))
            background.restoreGState()
        }
    }
    background.setFillColor(CGColor(gray: 0, alpha: 0.15))
    background.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let margin = mask(size) { x, y in
        let outside = max(artRect.minX - x, x - artRect.maxX, artRect.minY - y, y - artRect.maxY)
        return 0.7 * smoothstep(0, origin, outside)
    }
    background.saveGState()
    background.clip(to: CGRect(x: 0, y: 0, width: size, height: size), mask: margin)
    background.setFillColor(CGColor(gray: 0, alpha: 1))
    background.fill(CGRect(x: 0, y: 0, width: size, height: size))
    background.restoreGState()
    write(background.makeImage()!, to: resDir.appendingPathComponent("mipmap-\(folder)/ic_launcher_background.png"))

    // foreground: the art at 78 dp, its outer 6 dp fading out
    let feather = featherDp * scale
    let fade = mask(size) { x, y in
        let inside = min(x - artRect.minX, artRect.maxX - x, y - artRect.minY, artRect.maxY - y)
        return smoothstep(0, feather, inside)
    }
    let foreground = context(size, opaque: false)
    foreground.clip(to: CGRect(x: 0, y: 0, width: size, height: size), mask: fade)
    foreground.draw(artwork, in: artRect)
    write(foreground.makeImage()!, to: resDir.appendingPathComponent("mipmap-\(folder)/ic_launcher_foreground.png"))

    // monochrome: the stones in white at the foreground's scale
    let monochrome = context(size, opaque: false)
    monochrome.clip(to: artRect, mask: stonesMask)
    monochrome.setFillColor(CGColor(gray: 1, alpha: 1))
    monochrome.fill(artRect)
    write(monochrome.makeImage()!, to: resDir.appendingPathComponent("mipmap-\(folder)/ic_launcher_monochrome.png"))

}

let adaptive = """
<?xml version="1.0" encoding="utf-8"?>
<!-- The launcher icon (android/scripts/make-icon.swift from ios/Config/AppIcon-source.png, the iOS app's icon): the rune
     stones over their cobblestone, and a monochrome layer for Android 13's themed icons. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>

"""
writeText(adaptive, to: resDir.appendingPathComponent("mipmap-anydpi/ic_launcher.xml"))
writeText(adaptive, to: resDir.appendingPathComponent("mipmap-anydpi/ic_launcher_round.xml"))

let store = context(512, opaque: true)
store.draw(artwork, in: CGRect(x: 0, y: 0, width: 512, height: 512))
write(store.makeImage()!, to: storeDir.appendingPathComponent("icon-512.png"))
