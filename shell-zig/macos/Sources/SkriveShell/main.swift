import AppKit
import Foundation

// Unbuffered stdout so diagnostic lines (SKRIVE_DIAG) survive a SIGTERM
// when the process output is piped to a file rather than a tty.
setbuf(stdout, nil)

// Install native crash handlers before anything else so a crash during
// startup is still captured (Stage 6.5). Local logs only, no telemetry.
CrashLog.install()

// Programmatic AppKit entry point — no .xcodeproj, no @NSApplicationMain.
// `.regular` activation gives the spike a dock tile and a menu bar without
// an Info.plist activation policy.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
