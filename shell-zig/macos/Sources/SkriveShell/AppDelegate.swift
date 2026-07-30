import AppKit
import WebKit
import Sparkle
import SkriveShellKit

// Stage 1 host: one transparent-titlebar NSWindow holding a WKWebView that
// loads the existing renderer bundle, with the Zig core wired in behind the
// native bridge. The chrome mirrors the Electron shell
// (shell/src/main/index.ts): hidden-inset titlebar, traffic lights nudged
// to the topbar centerline, theme-aware pre-paint background.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var bridge: CoreBridge!
    // Sparkle auto-updater. We drive the updater engine (SPUUpdater) with a
    // *custom* user driver (SkriveUpdaterDriver) instead of Sparkle's stock UI,
    // so update state flows into Skrive's own renderer components via the
    // updater:status contract rather than Sparkle's grey alerts. SPUUpdater
    // reads SUFeedURL / SUPublicEDKey from Info.plist and schedules background
    // checks; both are held for the app's lifetime.
    private var updater: SPUUpdater!
    private var updaterDriver: SkriveUpdaterDriver!
    // Shared between the bridge (sets it on project:snapshot) and the asset
    // scheme handler (serves images from it).
    private let activeProject = ActiveProject()

    // Electron parity (shell/src/main/index.ts): trafficLightPosition
    // { x: 12, y: 13 } against a 40px topbar. Confirmed by eye on macOS Tahoe:
    // AppKit's native cluster at this inset is the desired look.
    private let trafficLightInset = NSPoint(x: 12, y: 13)

    // Clear gap between the rightmost light and the renderer's first
    // control. The renderer (app/src/index.css `.header.is-macos`)
    // hardcodes a 72px inset tuned for ~20px light spacing; macOS 26
    // (Tahoe) spaces them at 23px, so the cluster now ends at x:72 and the
    // toggle touches it. The shell positions the lights, so the shell tells
    // the renderer the real inset: clusterRight + this gap.
    private let trafficLightGap: CGFloat = 14
    private var rendererLoaded = false

    // KVO token for the system-appearance observation that re-swaps the dock
    // tile (the flat .icns can't carry a dark variant; we swap the running
    // tile ourselves, parity with the Electron shell's applyDockIcon).
    private var appearanceObservation: NSKeyValueObservation?

    // Headless smoke test, enabled with SKRIVE_DIAG=1: relays the webview
    // console to stdout and, once the renderer settles, round-trips
    // app:version / app:platform and probes the rendered DOM. Repeatable
    // evidence for the 1.1 done-criteria without a screen.
    private let diagEnabled = ProcessInfo.processInfo.environment["SKRIVE_DIAG"] == "1"

    // Smoke mode (SKRIVE_SMOKE=1): the diagnostics above, plus an automatic
    // quit once the self-test has reported. Implies SKRIVE_DIAG.
    //
    // The quit is the point, not tidiness: it routes through
    // applicationShouldTerminate, so a run exercises the pre-quit flush and its
    // ack round trip, and the flush duration it logs tells the caller whether
    // the renderer answered or the 2s backstop fired. It also means the process
    // ends by itself, so a runner can wait on the exit code instead of killing
    // the app and learning nothing about how it shuts down.
    private let smokeEnabled = ProcessInfo.processInfo.environment["SKRIVE_SMOKE"] == "1"

    // Update-UI preview harness (SKRIVE_UPDATER_DEMO=1): once the renderer is
    // up, emit a scripted updater:status sequence so the custom update card and
    // toasts can be seen without a real newer release. Observe-only — clicking
    // Download/Restart drops out of the demo into the real updater flow.
    private let updaterDemo =
        ProcessInfo.processInfo.environment["SKRIVE_UPDATER_DEMO"] == "1"
    private var updaterDemoRan = false

    // 1.2 serving-mode bake-off, switchable at runtime: "scheme" (custom
    // skrive-app:// origin, the default) or "file" (loadFileURL, which the
    // 1.1 spike found cannot execute the renderer's ES-module bundle).
    private let servingMode = ProcessInfo.processInfo.environment["SKRIVE_SERVE"] ?? "scheme"

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Observe left mouse-downs so the renderer's topbar can drag the window
        // (SKR-240). Installed before the window exists: it is a tap on the event
        // stream, not tied to any window.
        WindowDrag.install()
        // Build the updater engine with our custom driver before the menu (the
        // "Check for Updates…" item drives it). startUpdater() is deferred until
        // after the bridge exists so the driver's status events have somewhere
        // to go before any (background) check can fire.
        updaterDriver = SkriveUpdaterDriver()
        updater = SPUUpdater(
            hostBundle: Bundle.main,
            applicationBundle: Bundle.main,
            userDriver: updaterDriver,
            delegate: nil
        )
        setupMenu()

        let isDark = NSApp.effectiveAppearance
            .bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable,
                        .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Skrive"
        window.minSize = NSSize(width: 720, height: 480)
        // Stay-resident lifecycle: closing the window keeps the app (and this
        // window object, with its live webview) alive so a dock-click reopen is
        // instant and preserves the renderer's open tabs and scroll. Without
        // this, AppKit releases the window on close and the reopen path would
        // dereference a freed window.
        window.isReleasedWhenClosed = false
        // Pre-paint flash color, theme-aware like the Electron shell: the
        // renderer's light-dark() CSS picks the final palette, but the
        // window paints first.
        window.backgroundColor = isDark
            ? NSColor(srgbRed: 0x16 / 255, green: 0x17 / 255, blue: 0x19 / 255, alpha: 1)
            : NSColor(srgbRed: 0xe7 / 255, green: 0xe8 / 255, blue: 0xea / 255, alpha: 1)
        window.delegate = self
        window.center()

        // The webview IS the content view, so it fills the whole window —
        // including up under the transparent titlebar (fullSizeContentView).
        // The renderer draws its own 40px topbar at y=0 and the traffic
        // lights overlay it, matching the Electron shell. Sizing to
        // contentLayoutRect instead would clip the content below the
        // titlebar and strand the lights in an empty band.
        webView = makeWebView()
        window.contentView = webView

        bridge = CoreBridge(
            webView: webView,
            configJSON: Resources.configJSON(),
            activeProject: activeProject
        )
        // Wire the updater <-> renderer contract. The driver streams status to
        // the renderer through the bridge; the renderer's check / download /
        // install actions route back to the engine and driver.
        updaterDriver.onStatus = { [weak self] payload in
            self?.bridge.emitEvent("updater:status", payload: payload)
        }
        bridge.onUpdaterCheck = { [weak self] in
            guard let self, self.updater.canCheckForUpdates else { return }
            self.updater.checkForUpdates()
        }
        bridge.onUpdaterDownloadAndInstall = { [weak self] in
            guard let self else { return }
            self.updaterDriver.downloadAndInstall {
                if self.updater.canCheckForUpdates { self.updater.checkForUpdates() }
            }
        }
        bridge.onUpdaterCurrent = { [weak self] in
            self?.updaterDriver.current ?? ["kind": "idle"]
        }

        // Now that status has somewhere to go, start the engine (schedules the
        // background check loop per Info.plist). A failure here is non-fatal —
        // the app runs, it just won't self-update — so log and continue.
        do {
            try updater.start()
        } catch {
            CrashLog.append("updater failed to start: \(error.localizedDescription)")
        }

        loadRenderer()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        positionTrafficLights()

        // Dock tile follows the system appearance, re-swapped on change.
        applyDockIcon()
        appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
            DispatchQueue.main.async { self?.applyDockIcon() }
        }
    }

    /// Swap the running dock tile to the dark brand mark under a dark system
    /// appearance, the light mark otherwise (parity with the Electron shell:
    /// macOS never swaps a flat .icns for dark mode, so we do it ourselves).
    /// Dock-only — Finder/Launchpad keep the bundle .icns.
    private func applyDockIcon() {
        let isDark = NSApp.effectiveAppearance
            .bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let resource = isDark ? "icon-dark" : "icon"
        guard let url = Bundle.main.url(forResource: resource, withExtension: "png"),
            let image = NSImage(contentsOf: url)
        else { return }
        NSApp.applicationIconImage = image
    }

    // Stay resident when the last window closes (macOS standard): the app keeps
    // running in the dock and only a real Quit (Cmd-Q) terminates. Closing the
    // window is then instant — it never routes through the pre-quit flush
    // handshake — and reopening is a cheap re-show rather than a cold start.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        false
    }

    /// Dock-icon click (or any reopen) with no visible window re-shows the
    /// existing window. The window and its webview were kept alive on close
    /// (isReleasedWhenClosed = false), so this restores the prior session
    /// instantly instead of reloading the renderer.
    func applicationShouldHandleReopen(
        _ sender: NSApplication, hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    /// Full standard macOS menu bar (4.0), replicating Electron's *default*
    /// menu. A programmatic AppKit app has no menu unless one is installed,
    /// and Electron supplied this for free. Items use the standard
    /// first-responder selectors (`undo:`, `cut:`, `performClose:`, ...) so
    /// WKWebView's first responder handles them in the editor and in dialog
    /// text fields. Scope guard: the DEFAULT menu only — NO app-specific File
    /// items; Skrive's New/Open/Save live in the renderer command palette.
    private func setupMenu() {
        let mainMenu = NSMenu()

        // App menu. (The first menu's title is replaced with the process
        // name by AppKit regardless of what we set here.)
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(
            withTitle: "About Skrive",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        // Drives our SPUUpdater via checkForUpdatesAction; validateMenuItem
        // disables it while a check/session is in progress (canCheckForUpdates).
        let checkForUpdates = appMenu.addItem(
            withTitle: "Check for Updates…",
            action: #selector(checkForUpdatesAction(_:)),
            keyEquivalent: ""
        )
        checkForUpdates.target = self
        appMenu.addItem(.separator())
        let servicesItem = appMenu.addItem(
            withTitle: "Services", action: nil, keyEquivalent: ""
        )
        let servicesMenu = NSMenu()
        servicesItem.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Hide Skrive",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthers = appMenu.addItem(
            withTitle: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(
            withTitle: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Skrive",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        // Edit menu — native text editing in the webview and in dialog
        // fields. Dispatched through the responder chain to WKWebView.
        let editMenu = addSubmenu(to: mainMenu, title: "Edit")
        addItem(editMenu, "Undo", "undo:", "z")
        addItem(editMenu, "Redo", "redo:", "z", [.command, .shift])
        editMenu.addItem(.separator())
        addItem(editMenu, "Cut", "cut:", "x")
        addItem(editMenu, "Copy", "copy:", "c")
        addItem(editMenu, "Paste", "paste:", "v")
        addItem(editMenu, "Paste and Match Style", "pasteAsPlainText:", "v",
                [.command, .option, .shift])
        addItem(editMenu, "Delete", "delete:", "")
        addItem(editMenu, "Select All", "selectAll:", "a")

        // View menu — reload, full screen, and (dev builds) the inspector.
        let viewMenu = addSubmenu(to: mainMenu, title: "View")
        let reload = viewMenu.addItem(
            withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r"
        )
        reload.target = self
        addItem(viewMenu, "Toggle Full Screen", "toggleFullScreen:", "f", [.command, .control])

        // Window menu — AppKit manages the window list once assigned.
        let windowMenu = addSubmenu(to: mainMenu, title: "Window")
        addItem(windowMenu, "Minimize", "performMiniaturize:", "m")
        addItem(windowMenu, "Zoom", "performZoom:", "")
        windowMenu.addItem(.separator())
        // No File menu (scope guard), so Close lives here to bind Cmd-W.
        addItem(windowMenu, "Close", "performClose:", "w")
        windowMenu.addItem(.separator())
        addItem(windowMenu, "Bring All to Front", "arrangeInFront:", "")
        NSApp.windowsMenu = windowMenu

        // Help menu — assigning it gives the standard search field.
        let helpMenu = addSubmenu(to: mainMenu, title: "Help")
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    /// Add a titled submenu to the menu bar and return its NSMenu.
    private func addSubmenu(to mainMenu: NSMenu, title: String) -> NSMenu {
        let item = NSMenuItem()
        mainMenu.addItem(item)
        let menu = NSMenu(title: title)
        item.submenu = menu
        return menu
    }

    /// Add a first-responder action item (string selector resolved at runtime,
    /// the standard idiom for code-built menus). `nil` target routes through
    /// the responder chain to WKWebView / the key window.
    @discardableResult
    private func addItem(
        _ menu: NSMenu,
        _ title: String,
        _ selector: String,
        _ key: String,
        _ modifiers: NSEvent.ModifierFlags = .command
    ) -> NSMenuItem {
        let item = menu.addItem(
            withTitle: title, action: Selector((selector)), keyEquivalent: key
        )
        if !key.isEmpty { item.keyEquivalentModifierMask = modifiers }
        return item
    }

    /// View > Reload. Re-requests the renderer from its origin.
    @objc private func reloadPage(_ sender: Any?) {
        webView?.reload()
    }

    /// App menu > Check for Updates… — a user-initiated check, surfaced through
    /// the custom driver's status events (not Sparkle's stock dialog).
    @objc private func checkForUpdatesAction(_ sender: Any?) {
        guard updater?.canCheckForUpdates == true else { return }
        updater.checkForUpdates()
    }

    /// Disable "Check for Updates…" while a check/session is already running.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(checkForUpdatesAction(_:)) {
            return updater?.canCheckForUpdates ?? false
        }
        return true
    }

    private var quitting = false

    /// Pre-quit flush, then an immediate exit. Pause the quit once, ask the
    /// renderer to flush pending saves, and exit(0) on its ack (or after the
    /// flush's own 2s backstop so a wedged renderer can't trap the app).
    ///
    /// exit(0) instead of `reply(toApplicationShouldTerminate:)` is the fix for
    /// the sluggish Cmd-Q: once the ack confirms every save is on disk, AppKit's
    /// graceful teardown (tearing down the WKWebView content process and
    /// Sparkle's XPC services) only adds a visible beat and protects nothing we
    /// haven't already persisted, so we skip it. The core's writes are
    /// synchronous fs that completed before the ack, so nothing is buffered.
    ///
    /// CALLER CONSTRAINT: never invoke NSApp.terminate() from inside a main
    /// dispatch queue block. Returning .terminateLater leaves AppKit spinning a
    /// nested run loop until the reply; if that loop is spun inside a main-queue
    /// block, the serial main queue cannot drain until the block returns, and it
    /// cannot return until the reply arrives. Everything the flush needs is on
    /// that queue — the core's response hop in skriveCoreEmit, and the flush
    /// backstop — so the app deadlocks and never exits. The run loop itself
    /// stays live throughout (WebKit callbacks and common-mode timers still
    /// fire), which makes the hang look like an ack that was never sent. Quit
    /// from an event handler or a run-loop timer instead.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if bridge == nil { return .terminateNow }
        if quitting { return .terminateLater }   // a second Cmd-Q mid-flush
        quitting = true
        // Smoke runs need this timing too: it is how the caller tells a real
        // flush ack apart from the 2s backstop firing on a wedged renderer.
        let start = (diagEnabled || smokeEnabled) ? Date() : nil
        bridge.beginFlush {
            if let start {
                NSLog("[skrive] pre-quit flush took %.0f ms",
                      Date().timeIntervalSince(start) * 1000)
            }
            exit(0)
        }
        return .terminateLater
    }

    // MARK: - WebView

    private func makeWebView() -> WKWebView {
        let controller = WKUserContentController()
        controller.add(self, name: "skriveInvoke")
        let bridgeSource = Resources.bridgeJS()
        controller.addUserScript(
            WKUserScript(
                source: bridgeSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        if diagEnabled || smokeEnabled {
            controller.add(self, name: "skriveDiag")
            controller.addUserScript(
                WKUserScript(
                    source: Diagnostics.consoleRelaySource,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
        }

        let config = WKWebViewConfiguration()
        config.userContentController = controller

        // Scheme handlers must be registered on the configuration before the
        // webview is created.
        if servingMode == "scheme", let root = Resources.rendererRootURL() {
            config.setURLSchemeHandler(
                AppSchemeHandler(rendererRoot: root),
                forURLScheme: AppSchemeHandler.scheme
            )
        }
        // The asset origin is independent of the app serving mode (a separate
        // scheme handler in all three shapes). It serves from the active
        // project root, which the bridge updates as the renderer opens
        // projects; before the first open it serves nothing.
        config.setURLSchemeHandler(
            AssetSchemeHandler(activeProject: activeProject),
            forURLScheme: AssetSchemeHandler.scheme
        )

        #if DEBUG
        // Belt-and-suspenders for the right-click "Inspect Element" item: the
        // legacy developer-extras preference, guarded by its private setter
        // selector so a future SDK change degrades to a no-op rather than a
        // KVC crash. Pairs with isInspectable below.
        if config.preferences.responds(to: Selector(("_setDeveloperExtrasEnabled:"))) {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        #endif

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        #if DEBUG
        // Dev-gated Web Inspector. The supported entry points are right-click
        // "Inspect Element" and Safari's Develop menu (Develop > this Mac >
        // Skrive). NB: the private programmatic _WKInspector.show() is a silent
        // no-op on macOS 26, so there is deliberately no menu/keyboard toggle.
        view.isInspectable = true
        #endif
        // Let the window's pre-paint color show through until first paint.
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    // MARK: - Navigation and link policy

    /// Keep the main frame on the app origin and route off-origin links to the
    /// browser (parity with Electron's `setWindowOpenHandler` deny + the
    /// implicit will-navigate guard). A link click inside a note must open
    /// externally, never replace the running app.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
            let scheme = url.scheme?.lowercased()
        else {
            decisionHandler(.allow)
            return
        }
        // Native HMR: the SKRIVE_DEV_URL origin loads in place. Without this the
        // http case below would bounce the dev server to the browser, leaving
        // the app window blank. Mirrors the Windows host's nav backstop.
        if let dev = Resources.devURL(),
            url.scheme == dev.scheme, url.host == dev.host, url.port == dev.port {
            decisionHandler(.allow)
            return
        }
        switch scheme {
        case AppSchemeHandler.scheme, AssetSchemeHandler.scheme, "about", "blob", "data":
            // In-app origins and renderer-internal schemes load in place.
            decisionHandler(.allow)
        case "http", "https", "mailto", "tel", "skrive":
            ExternalLink.open(url)
            decisionHandler(.cancel)
        default:
            // Unknown scheme (file://, ftp://, ...): refuse, so the app frame
            // can never be navigated off its origin. ExternalLink would refuse
            // it anyway.
            decisionHandler(.cancel)
        }
    }

    /// `target=_blank` / `window.open`: open externally (if allowed) and never
    /// spawn a child webview.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { ExternalLink.open(url) }
        return nil
    }

    // MARK: - Diagnostics

    /// The WebKit content process died (OOM, a renderer crash, a GPU fault).
    /// This is not a host crash, so the OS writes no report for it — log a
    /// breadcrumb and reload so the user gets their app back rather than a
    /// blank window (Stage 6.5 crash logs).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        CrashLog.logWebviewTermination()
        loadRenderer()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        rendererLoaded = true
        applyTitlebarInset()
        runUpdaterDemoIfRequested()
        guard diagEnabled || smokeEnabled else { return }
        // Give the React boot sequence (loadAppState -> snapshot -> worker
        // -> render) time to settle before probing.
        // The bundled sample project's absolute path, as a JS string literal
        // (or `null` when absent), so the self-test can drive a native
        // project:snapshot against real on-disk files.
        let projectRootLiteral =
            Resources.projectRootURL().map { JSEscape.stringLiteral($0.path) } ?? "null"
        let probe = Diagnostics.selfTestSource
            .replacingOccurrences(of: "%SERVE%", with: servingMode)
            .replacingOccurrences(of: "%PROJECT_ROOT%", with: projectRootLiteral)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            webView.evaluateJavaScript(probe, completionHandler: nil)
        }
    }

    private func loadRenderer() {
        // Native HMR: SKRIVE_DEV_URL points the webview at the Vite dev server
        // instead of the bundled renderer. The bridge is injected via
        // WKUserScript (origin-independent), so window.skrive still works.
        if let dev = Resources.devURL() {
            webView.load(URLRequest(url: dev))
            return
        }
        guard let index = Resources.rendererIndexURL(),
              let root = Resources.rendererRootURL() else {
            presentFatal("Renderer bundle not found. Set SKRIVE_RENDERER_DIR or bundle it under Resources/renderer.")
            return
        }
        if servingMode == "scheme" {
            webView.load(URLRequest(url: AppSchemeHandler.indexURL))
        } else {
            // file:// origin — kept for the bake-off matrix; does not
            // execute the ES-module bundle (1.1 finding).
            webView.loadFileURL(index, allowingReadAccessTo: root)
        }
    }

    /// SKRIVE_UPDATER_DEMO=1: walk the renderer through the update states once
    /// the page is up, so the custom update card + toasts can be reviewed
    /// without a real release. Emits straight onto the updater:status channel
    /// (the same path the driver uses); the real updater is untouched.
    private func runUpdaterDemoIfRequested() {
        guard updaterDemo, !updaterDemoRan, let bridge else { return }
        updaterDemoRan = true
        let version = "9.9.9"
        func emit(_ payload: [String: Any], at delay: Double) {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak bridge] in
                bridge?.emitEvent("updater:status", payload: payload)
            }
        }
        // Give the renderer's boot + updater subscription time to settle.
        emit(["kind": "checking"], at: 2.0)
        emit([
            "kind": "available", "version": version,
            "releaseNotes": "What's new in Skrive \(version)\n\n"
                + "• Custom in-app update experience\n"
                + "• Instant quit and stay-resident windows\n"
                + "• A tidier drag-to-install window\n"
                + "• Assorted fixes and polish"
        ], at: 3.2)
        var t = 4.8
        for pct in stride(from: 0, through: 100, by: 4) {
            emit([
                "kind": "downloading", "version": version,
                "percent": Double(pct),
                "bytesPerSecond": Double(2_400_000 + pct * 22_000)
            ], at: t)
            t += 0.16
        }
        emit(["kind": "ready", "version": version], at: t + 0.5)
    }

    // MARK: - Bridge in

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "skriveDiag", let line = message.body as? String {
            print("[diag] \(line)")
            // In smoke mode the self-test's report is the end of the run: quit
            // through the normal path so the pre-quit flush and its ack are
            // exercised, and the process supplies its own exit code. A short
            // delay lets the console relay drain any error logged alongside the
            // report, which would otherwise be lost with the process.
            // A run-loop timer, NOT DispatchQueue.main.asyncAfter. terminate()
            // must not be called from inside a main-queue block: see the note on
            // applicationShouldTerminate. This is where that was learned.
            if smokeEnabled, line.hasPrefix("SELFTEST ") {
                Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { _ in
                    NSApp.terminate(nil)
                }
            }
            return
        }
        guard message.name == "skriveInvoke",
              let json = message.body as? String else { return }
        bridge.handle(requestJSON: json)
    }

    // MARK: - Traffic lights

    func windowDidResize(_ notification: Notification) { positionTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { positionTrafficLights() }

    // Nudge the standard window buttons to match the Electron inset. AppKit
    // re-lays them out on resize/focus, so this re-runs from the window
    // delegate. Exact parity with Electron's compositor is approximate; the
    // log records how close it lands.
    private func positionTrafficLights() {
        let buttons = [
            window.standardWindowButton(.closeButton),
            window.standardWindowButton(.miniaturizeButton),
            window.standardWindowButton(.zoomButton)
        ].compactMap { $0 }
        guard let first = buttons.first, let titlebar = first.superview else { return }

        let buttonHeight = first.frame.height
        // AppKit is bottom-left origin; Electron's y is from the top.
        let y = titlebar.bounds.height - trafficLightInset.y - buttonHeight
        let spacing = buttons.count > 1
            ? buttons[1].frame.minX - buttons[0].frame.minX
            : 20
        for (i, button) in buttons.enumerated() {
            button.setFrameOrigin(
                NSPoint(x: trafficLightInset.x + CGFloat(i) * spacing,
                        y: max(0, y))
            )
        }
        applyTitlebarInset()
    }

    // Tell the renderer how far to inset its topbar so its first control
    // clears the lights with `trafficLightGap` to spare. Computed from the
    // actual button geometry (resilient to per-OS light sizing), injected
    // as a shell-owned <style>. Runtime chrome coordination only — it does
    // not touch app/.
    private func applyTitlebarInset() {
        guard rendererLoaded, let webView else { return }
        let clusterRight = [
            window.standardWindowButton(.closeButton),
            window.standardWindowButton(.miniaturizeButton),
            window.standardWindowButton(.zoomButton)
        ].compactMap { $0?.frame.maxX }.max() ?? 72
        let inset = Int((clusterRight + trafficLightGap).rounded())
        let css = ".header.is-macos{padding-left:\(inset)px !important;}"
        let js = """
        (() => {
          let s = document.getElementById('skrive-shell-chrome');
          if (!s) { s = document.createElement('style'); s.id = 'skrive-shell-chrome';
                    document.head.appendChild(s); }
          s.textContent = \(JSEscape.stringLiteral(css));
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Errors

    private func presentFatal(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Skrive (Zig shell) failed to start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}
