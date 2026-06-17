// swift-tools-version:6.0
import PackageDescription
import Foundation

// The Zig core is built separately (`zig build` in ../core) into a static
// archive. We compute its absolute path from this manifest's location so
// `swift build` links it regardless of the invoking directory. See
// shell-zig/README.md for the build order (renderer -> bridge -> core ->
// host).
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let coreLibDir = "\(packageDir)/../core/zig-out/lib"

let package = Package(
    name: "SkriveShell",
    platforms: [.macOS(.v14)],
    targets: [
        // Header-only wrapper around the Zig core's C ABI. The actual
        // symbols are linked from libskrive_core.a by the executable.
        .target(name: "CSkriveCore"),
        // Pure host logic that warrants unit tests, kept out of the
        // executable target so `swift test` can import it. Currently the
        // delivery-rule escaper (JSEscape).
        .target(name: "SkriveShellKit"),
        .executableTarget(
            name: "SkriveShell",
            dependencies: ["CSkriveCore", "SkriveShellKit"],
            linkerSettings: [
                .unsafeFlags(["-L\(coreLibDir)", "-lskrive_core"]),
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit")
            ]
        ),
        .testTarget(
            name: "SkriveShellKitTests",
            dependencies: ["SkriveShellKit"]
        )
    ]
)
