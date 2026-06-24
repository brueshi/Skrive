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
    dependencies: [
        // Sparkle is the ~20-year indie-Mac auto-update standard (Stage 6.1,
        // updater engine LOCKED). It vends a binary XCFramework; SwiftPM links
        // it here and Package.resolved pins the exact build, but because we
        // hand-assemble Skrive.app (not Xcode), build-macos.sh copies
        // Sparkle.framework into Contents/Frameworks and signs its nested XPC
        // services / helper apps itself.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.3")
    ],
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
            dependencies: [
                "CSkriveCore",
                "SkriveShellKit",
                .product(name: "Sparkle", package: "Sparkle")
            ],
            linkerSettings: [
                // -lc++ and the CoreServices/CoreFoundation frameworks are
                // for the vendored e-dant/watcher C++ TU linked into
                // libskrive_core: it uses libc++ (std::filesystem/thread) and
                // FSEvents (CoreServices). The static archive defers these
                // symbols to this final link.
                .unsafeFlags(["-L\(coreLibDir)", "-lskrive_core", "-lc++"]),
                // Sparkle.framework lives in Contents/Frameworks of the
                // assembled app; its install name is @rpath-relative, so the
                // executable needs this rpath to find it at launch. -rpath is a
                // linker flag, so route it through the driver with -Xlinker.
                .unsafeFlags([
                    "-Xlinker", "-rpath",
                    "-Xlinker", "@executable_path/../Frameworks"
                ]),
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("CoreServices"),
                .linkedFramework("CoreFoundation")
            ]
        ),
        .testTarget(
            name: "SkriveShellKitTests",
            dependencies: ["SkriveShellKit"]
        )
    ]
)
