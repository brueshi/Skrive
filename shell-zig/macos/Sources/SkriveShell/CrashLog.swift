import AppKit
import Foundation

// Local, privacy-preserving crash + diagnostics logging (Stage 6.5). Everything
// is written to ~/Library/Application Support/Skrive/crashes and NEVER uploaded
// — the user grabs the folder by hand via Settings → "Reveal diagnostics" and
// sends it in. This matches Skrive's no-telemetry posture and, as a side
// benefit, brings field crashes to the Mac-based dev without a reproduction.
//
// Three native sources are captured here; the renderer error path comes in over
// the `log:append` command (CoreBridge), and webview content-process death
// comes in via the navigation delegate. macOS already writes a full,
// symbolicated .ips report for native crashes under ~/Library/Logs/
// DiagnosticReports — these handlers add a Skrive-owned breadcrumb plus capture
// the things the OS report does NOT cover (uncaught NSExceptions, renderer JS
// errors, webview process death).

// Precomputed C strings for the signal handler. A signal handler may only call
// async-signal-safe functions, so we cannot allocate, format, or touch Swift
// String machinery inside it. These are strdup'd once at install().
// Written once at install() on the main thread before any other thread exists,
// then only read inside the signal handler — externally synchronized by program
// order, so the unchecked annotation is sound.
nonisolated(unsafe) private var crashPathC: UnsafeMutablePointer<CChar>?
nonisolated(unsafe) private var crashMarkerC: UnsafeMutablePointer<CChar>?

// Signal handler: append a fixed marker + a raw backtrace to a pre-resolved
// path using only async-signal-safe calls, then restore the default disposition
// and re-raise so the OS still writes its full crash report. backtrace /
// backtrace_symbols_fd are the standard fd-direct backtrace tools intended for
// exactly this; the buffer lives on the handler's own stack (no malloc).
private func skriveSignalHandler(_ sig: Int32) {
    if let path = crashPathC {
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        if fd >= 0 {
            if let marker = crashMarkerC { _ = write(fd, marker, strlen(marker)) }
            var frames = [UnsafeMutableRawPointer?](repeating: nil, count: 128)
            let count = backtrace(&frames, Int32(frames.count))
            backtrace_symbols_fd(&frames, count, fd)
            close(fd)
        }
    }
    signal(sig, SIG_DFL)
    raise(sig)
}

// Uncaught Objective-C / Cocoa exceptions. Unlike signals this runs in a normal
// context, so Foundation is fair game — write a full, human-readable report.
private func skriveExceptionHandler(_ exception: NSException) {
    let lines = [
        "name: \(exception.name.rawValue)",
        "reason: \(exception.reason ?? "(none)")",
        "userInfo: \(exception.userInfo.map { String(describing: $0) } ?? "(none)")",
        "stack:",
        exception.callStackSymbols.joined(separator: "\n")
    ]
    CrashLog.writeReport(prefix: "exception", body: lines.joined(separator: "\n"))
}

enum CrashLog {
    /// ~/Library/Application Support/Skrive/crashes — the same app-data root the
    /// core uses (Resources.configJSON), with the crashes subfolder.
    static let crashesDir: URL = {
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory())
        return appSupport
            .appendingPathComponent("Skrive", isDirectory: true)
            .appendingPathComponent("crashes", isDirectory: true)
    }()

    /// Install the native crash handlers. Call as early as possible (before the
    /// app runs) so a crash during startup is still captured.
    static func install() {
        ensureDir()

        // Stash the native-crash log path + marker as C strings for the signal
        // handler (which can't allocate). All native crashes append to one file.
        let nativeLog = crashesDir.appendingPathComponent("native-crash.log").path
        crashPathC = strdup(nativeLog)
        crashMarkerC = strdup(
            "\n=== Skrive host crash (signal). Full symbolicated report: "
                + "~/Library/Logs/DiagnosticReports. Backtrace follows ===\n"
        )

        NSSetUncaughtExceptionHandler(skriveExceptionHandler)

        // The fatal signals worth a breadcrumb. SIGABRT also covers Zig core
        // panics (which trap), so a core panic lands here as a native crash.
        for sig in [SIGSEGV, SIGABRT, SIGILL, SIGBUS, SIGFPE, SIGTRAP] {
            signal(sig, skriveSignalHandler)
        }
    }

    /// Append a renderer-diagnostics line (from the `log:append` command). Main
    /// thread; renderer errors are rare, so a plain seek-and-append is fine.
    static func append(_ line: String) {
        ensureDir()
        let url = crashesDir.appendingPathComponent("renderer.log")
        let stamped = "[\(timestamp())] \(line)\n"
        guard let data = stamped.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    /// Webview content-process death — not a host crash (no .ips), so worth its
    /// own breadcrumb. The host reloads the renderer to recover.
    static func logWebviewTermination() {
        writeReport(
            prefix: "webview",
            body: "The WebKit content process terminated; reloading the renderer."
        )
    }

    /// Open the crashes folder in Finder (Settings → "Reveal diagnostics").
    static func reveal() {
        ensureDir()
        NSWorkspace.shared.open(crashesDir)
    }

    /// Write a single timestamped report file (used by the exception + webview
    /// paths, which run in a normal context).
    static func writeReport(prefix: String, body: String) {
        ensureDir()
        let name = "\(prefix)-\(Int(Date().timeIntervalSince1970)).log"
        let url = crashesDir.appendingPathComponent(name)
        let text = "[\(timestamp())] Skrive \(prefix)\n\(body)\n"
        try? text.data(using: .utf8)?.write(to: url)
    }

    private static func ensureDir() {
        try? FileManager.default.createDirectory(
            at: crashesDir, withIntermediateDirectories: true
        )
    }

    private static func timestamp() -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: Date())
    }
}
