import Foundation
import WebKit
import CSkriveCore

// Owns the Zig core and shuttles envelopes across the C ABI. Host -> core
// is `handle`; core -> renderer is the `emit` callback, marshaled to the
// webview via the delivery rule. One instance per window.
//
// Everything here runs on the main thread: `handle` is called from the
// script-message handler, and the Stage 1 core invokes `emit`
// synchronously inside that same call. Hence @MainActor, and the C
// callback asserts the invariant with `assumeIsolated`. When Stage 2 lets
// the core emit from a thread pool, that is where the host marshals back —
// a localized change behind this same surface.
@MainActor
final class CoreBridge {
    // Touched only on the main thread in practice; `nonisolated(unsafe)`
    // lets the (nonisolated) deinit free it without a Sendable wrapper.
    nonisolated(unsafe) private var core: OpaquePointer?
    private weak var webView: WKWebView?

    init(webView: WKWebView, configJSON: String) {
        self.webView = webView
        // The emit closure captures nothing, so it converts to a C
        // function pointer. `userdata` carries us back into Swift.
        let userdata = Unmanaged.passUnretained(self).toOpaque()
        configJSON.withCString { cfg in
            core = skrive_core_create(
                cfg,
                { ud, msg in
                    guard let ud, let msg else { return }
                    let bridge = Unmanaged<CoreBridge>
                        .fromOpaque(ud)
                        .takeUnretainedValue()
                    let json = String(cString: msg)
                    MainActor.assumeIsolated { bridge.dispatch(json) }
                },
                userdata
            )
        }
    }

    deinit {
        if let core { skrive_core_destroy(core) }
    }

    /// Host -> core. The core replies synchronously through `dispatch`.
    func handle(requestJSON: String) {
        guard let core else { return }
        requestJSON.withCString { skrive_core_handle(core, $0) }
    }

    /// Core -> renderer. Delivered as the one fixed dispatch call with the
    /// envelope escaped to a JS string literal (Part I delivery rule).
    private func dispatch(_ envelopeJSON: String) {
        let script = "window.__skriveDispatch(\(JSEscape.stringLiteral(envelopeJSON)));"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
