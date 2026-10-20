// Renders the app icon from ios/Config/AppIcon-source.png: the "RS" rune stones of the 2004 RuneScape logo on dark
// cobblestone. The source is painted art (340 × 340), not a game sprite, so it is scaled up smoothly rather than
// nearest-neighbour.
//
//   swift ios/scripts/make-icon.swift [<source png>] [<appiconset dir>]
//
// Defaults: ios/Config/AppIcon-source.png and ios/LostCity/Assets.xcassets/AppIcon.appiconset. Writes three 1024 × 1024 PNGs
// and Contents.json:
//   AppIcon.png         the stones on the cobblestone, opaque (the default appearance)
//   AppIcon-Dark.png    the same: the icon is dark already
//   AppIcon-Tinted.png  the same in greys (iOS colours it with the tint)
import CoreGraphics
import Foundation
import ImageIO

let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let arguments = CommandLine.arguments.dropFirst()
let sourceURL = arguments.first.map { URL(fileURLWithPath: $0) } ?? ios.appendingPathComponent("Config/AppIcon-source.png")
let outDir = arguments.dropFirst().first.map { URL(fileURLWithPath: $0) }
    ?? ios.appendingPathComponent("LostCity/Assets.xcassets/AppIcon.appiconset")

let size = 1024
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("cannot read \(sourceURL.path)")
}

/// Draws the artwork over the whole icon into a context of `space` (opaque: the source has no transparency).
func render(in space: CGColorSpace, _ image: CGImage) -> CGImage {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        ?? CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                     bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    return context.makeImage()!
}

func write(_ image: CGImage, _ name: String) {
    let url = outDir.appendingPathComponent(name)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("cannot write \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("cannot write \(url.path)") }
    print("wrote \(url.path)")
}

let icon = render(in: sRGB, artwork)
write(icon, "AppIcon.png")
write(icon, "AppIcon-Dark.png")
// greys via a grey context, then back to RGB so all three PNGs have the same format
write(render(in: sRGB, render(in: CGColorSpace(name: CGColorSpace.genericGrayGamma2_2)!, icon)), "AppIcon-Tinted.png")

let contents = """
{
  "images" : [
    {
      "filename" : "AppIcon.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "AppIcon-Dark.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "tinted"
        }
      ],
      "filename" : "AppIcon-Tinted.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}

"""
try! contents.write(to: outDir.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
print("wrote \(outDir.appendingPathComponent("Contents.json").path)")
