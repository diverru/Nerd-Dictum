// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "parakeet-bridge",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "parakeet-bridge", targets: ["parakeet-bridge"])
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4")
    ],
    targets: [
        .executableTarget(
            name: "parakeet-bridge",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/parakeet-bridge"
        )
    ]
)
