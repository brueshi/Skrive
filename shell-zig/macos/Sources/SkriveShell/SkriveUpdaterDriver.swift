import AppKit
import Sparkle

// Drives Sparkle's update lifecycle into Skrive's own renderer UI instead of
// Sparkle's stock dialogs (Stage 1 of the custom-updater work). Each
// SPUUserDriver callback maps to an `UpdaterStatus` — the renderer's
// `updater:status` contract (shared/src/ipc-contracts.ts) — emitted via
// `onStatus`. The renderer's Download / Restart actions come back through
// `downloadAndInstall(check:)`, which fires Sparkle's retained reply blocks.
//
// Reply-block discipline is the load-bearing invariant: Sparkle expects each
// reply (`updateChoiceReply`, `installReply`) to fire exactly once. We nil a
// block the instant we call it, and `dismissUpdateInstallation` clears any that
// were never used, so a stale block can never be double-invoked (which would
// wedge the updater).
//
// The status dictionaries are built as plain JSON-shaped values so CoreBridge
// can hand them straight to the renderer; `NSNull()` stands in for a contract
// `null` (e.g. absent release notes).
@MainActor
final class SkriveUpdaterDriver: NSObject, SPUUserDriver {
    /// Emits an `UpdaterStatus` payload to the renderer. AppDelegate wires this
    /// to the bridge's event emitter once the bridge exists.
    var onStatus: (([String: Any]) -> Void)?

    /// The latest status, served back for the `updater:current` snapshot query.
    private(set) var current: [String: Any] = ["kind": "idle"]

    // Sparkle reply blocks, retained until the user acts (exactly-once).
    private var updateChoiceReply: ((SPUUserUpdateChoice) -> Void)?
    private var installReply: ((SPUUserUpdateChoice) -> Void)?

    // Download progress accounting. Sparkle reports an expected content length
    // once, then a stream of received-chunk lengths; we accumulate to a percent
    // and estimate a byte rate between emits.
    private var expectedLength: UInt64 = 0
    private var receivedLength: UInt64 = 0
    private var pendingVersion = ""
    private var lastEmitAt = Date.distantPast
    private var rateAnchorAt = Date.distantPast
    private var rateAnchorBytes: UInt64 = 0

    // Lifecycle breadcrumbs (SKRIVE_DIAG=1) — Sparkle's callback order is subtle
    // (e.g. dismissUpdateInstallation fires right after a terminal state), so a
    // trace of what fired in what order is the fastest way to diagnose.
    private let diag = ProcessInfo.processInfo.environment["SKRIVE_DIAG"] == "1"
    private func trace(_ message: String) {
        if diag { NSLog("[skrive.updater] \(message)") }
    }

    private func setStatus(_ status: [String: Any]) {
        current = status
        onStatus?(status)
    }

    /// Terminal resting states the UI should keep showing after Sparkle tears
    /// the session down. Only the transient states (checking/downloading) fall
    /// back to idle on dismissal.
    private var isTransient: Bool {
        let kind = current["kind"] as? String
        return kind == "checking" || kind == "downloading"
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
            as? String ?? "0.0.0"
    }

    // MARK: - Renderer-driven actions

    /// The renderer's `updater:downloadAndInstall`: install when an update is
    /// ready, download when one is merely available, otherwise kick a fresh
    /// check — parity with the Electron updater. `check` is supplied by the host
    /// (it owns the SPUUpdater).
    func downloadAndInstall(check: () -> Void) {
        if let reply = updateChoiceReply {
            updateChoiceReply = nil
            reply(.install)
        } else if let reply = installReply {
            installReply = nil
            reply(.install)
        } else {
            check()
        }
    }

    // MARK: - SPUUserDriver

    func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) {
        // First-launch consent. Grant scheduled checks (the app already ships
        // with automatic checks intended) and never send a system profile.
        reply(SUUpdatePermissionResponse(
            automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        trace("showUserInitiatedUpdateCheck -> checking")
        setStatus(["kind": "checking"])
    }

    func showUpdateFound(
        with appcastItem: SUAppcastItem,
        state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
        // Information-only updates can't be downloaded/installed; acknowledge by
        // dismissing and fall back to idle rather than offering a dead Download.
        if appcastItem.isInformationOnlyUpdate {
            reply(.dismiss)
            setStatus(["kind": "idle"])
            return
        }
        trace("showUpdateFound v\(appcastItem.displayVersionString) -> available")
        updateChoiceReply = reply
        pendingVersion = appcastItem.displayVersionString
        setStatus([
            "kind": "available",
            "version": appcastItem.displayVersionString,
            "releaseNotes": appcastItem.itemDescription ?? NSNull()
        ])
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        // Linked (non-embedded) release notes arrived after the update was
        // shown — fill them into the still-current `available` status.
        let text = String(data: downloadData.data, encoding: .utf8)
        setStatus([
            "kind": "available",
            "version": pendingVersion,
            "releaseNotes": text ?? NSNull()
        ])
    }

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {
        // Keep the existing `available` status (notes are a nicety, not a gate).
    }

    func showUpdateNotFoundWithError(_ error: any Error) async {
        trace("showUpdateNotFoundWithError -> no-update")
        setStatus([
            "kind": "no-update",
            "current": appVersion,
            "checkedAtMs": Date().timeIntervalSince1970 * 1000
        ])
    }

    func showUpdaterError(_ error: Error) async {
        trace("showUpdaterError -> error: \(error.localizedDescription)")
        setStatus(["kind": "error", "message": error.localizedDescription])
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        trace("showDownloadInitiated -> downloading 0%")
        expectedLength = 0
        receivedLength = 0
        rateAnchorBytes = 0
        rateAnchorAt = Date()
        setStatus([
            "kind": "downloading", "version": pendingVersion,
            "percent": 0, "bytesPerSecond": 0
        ])
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        expectedLength = expectedContentLength
        receivedLength = 0
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        receivedLength += length
        let now = Date()
        // Throttle to ~10 emits/sec; a chunk callback can fire far more often
        // and each emit is a webview evaluateJavaScript hop.
        guard now.timeIntervalSince(lastEmitAt) >= 0.1 else { return }
        let percent = expectedLength > 0
            ? min(100.0, Double(receivedLength) / Double(expectedLength) * 100.0)
            : 0
        let dt = now.timeIntervalSince(rateAnchorAt)
        let bytesPerSecond = dt > 0
            ? Double(receivedLength &- rateAnchorBytes) / dt : 0
        lastEmitAt = now
        rateAnchorAt = now
        rateAnchorBytes = receivedLength
        setStatus([
            "kind": "downloading", "version": pendingVersion,
            "percent": percent, "bytesPerSecond": max(0, bytesPerSecond)
        ])
    }

    func showDownloadDidStartExtractingUpdate() {
        // Download finished; extraction is indeterminate. Pin the bar at 100%
        // so it reads as "downloaded, finishing up" (the contract has no
        // dedicated extracting state).
        setStatus([
            "kind": "downloading", "version": pendingVersion,
            "percent": 100, "bytesPerSecond": 0
        ])
    }

    func showExtractionReceivedProgress(_ progress: Double) {
        // Stay at the 100% "finishing up" state set above.
    }

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        trace("showReady -> ready")
        installReply = reply
        setStatus(["kind": "ready", "version": pendingVersion])
    }

    func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void
    ) {
        // The app is being relaunched into the new version; nothing to show.
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool) async {
        // Rarely reached (the app has usually relaunched by now).
    }

    func dismissUpdateInstallation() {
        // Sparkle is tearing the session down. Drop any unused reply blocks so
        // they can't be invoked later, but DON'T clobber a meaningful terminal
        // state (no-update / available / ready / error) — that's exactly what
        // the UI should keep showing. Only a still-in-flight check/download
        // (e.g. cancelled) falls back to idle.
        trace("dismissUpdateInstallation (current=\(current["kind"] ?? "?"))")
        updateChoiceReply = nil
        installReply = nil
        if isTransient { setStatus(["kind": "idle"]) }
    }
}
