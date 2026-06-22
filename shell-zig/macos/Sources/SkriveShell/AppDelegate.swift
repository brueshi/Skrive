import AppKit
import WebKit
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
    // Shared between the bridge (sets it on project:snapshot) and the asset
    // scheme handler (serves images from it).
    private let activeProject = ActiveProject()

    // Electron parity (shell/src/main/index.ts): trafficLightPosition
    // { x: 12, y: 13 } against a 40px topbar.
    private let trafficLightInset = NSPoint(x: 12, y: 13)

    // Clear gap between the rightmost light and the renderer's first
    // control. The renderer (app/src/index.css `.header.is-macos`)
    // hardcodes a 72px inset tuned for ~20px light spacing; macOS 26
    // (Tahoe) spaces them at 23px, so the cluster now ends at x:72 and the
    // toggle touches it. The shell positions the lights, so the shell tells
    // the renderer the real inset: clusterRight + this gap.
    private let trafficLightGap: CGFloat = 14
    private var rendererLoaded = false

    // Headless smoke test, enabled with SKRIVE_DIAG=1: relays the webview
    // console to stdout and, once the renderer settles, round-trips
    // app:version / app:platform and probes the rendered DOM. Repeatable
    // evidence for the 1.1 done-criteria without a screen.
    private let diagEnabled = ProcessInfo.processInfo.environment["SKRIVE_DIAG"] == "1"

    // 1.2 serving-mode bake-off, switchable at runtime: "scheme" (custom
    // skrive-app:// origin, the default) or "file" (loadFileURL, which the
    // 1.1 spike found cannot execute the renderer's ES-module bundle).
    private let servingMode = ProcessInfo.processInfo.environment["SKRIVE_SERVE"] ?? "scheme"

    func applicationDidFinishLaunching(_ notification: Notification) {
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

        loadRenderer()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        positionTrafficLights()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        true
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

    private var quitFlushed = false

    /// Pre-quit flush handshake (parity with shell/src/main/index.ts): pause
    /// the quit once, ask the renderer to flush pending saves, and proceed on
    /// its ack or after a 2s backstop so a wedged renderer can't trap the app.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitFlushed || bridge == nil { return .terminateNow }
        bridge.beginFlush { [weak self] in
            self?.quitFlushed = true
            NSApp.reply(toApplicationShouldTerminate: true)
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

        if diagEnabled {
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        rendererLoaded = true
        applyTitlebarInset()
        guard diagEnabled else { return }
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

    // MARK: - Bridge in

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "skriveDiag", let line = message.body as? String {
            print("[diag] \(line)")
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
