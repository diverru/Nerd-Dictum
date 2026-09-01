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
        // Pinned to the exact version this bridge was written against
        // (Package.resolved is not committed, so a floating `from:` re-resolves
        // to the latest release on any clean checkout). NOTE: FluidAudio only
        // compiles for arm64 — its newer code uses Float16, which does not
        // exist on x86_64. Building from a Rosetta shell fails; build:swift
        // forces the native arch.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.14.4")
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
