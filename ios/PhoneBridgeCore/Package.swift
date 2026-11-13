// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PhoneBridgeCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "PhoneBridgeCore", targets: ["PhoneBridgeCore"]),
    ],
    targets: [
        .target(name: "PhoneBridgeCore"),
        .testTarget(name: "PhoneBridgeCoreTests", dependencies: ["PhoneBridgeCore"]),
    ]
)
