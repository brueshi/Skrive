import AppKit
import Foundation
import WebKit
import CSkriveCore
import SkriveShellKit

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

    /// Core -> renderer, OR a `host:` command for the host to perform.
    /// Host-delegated commands (trash now; open-external, clipboard,
    /// dialogs later) are intercepted here and never reach the renderer;
    /// everything else is forwarded per the Part I delivery rule. The cheap
    /// prefix guard keeps every (possibly large) response off the JSON
    /// parser — only host envelopes start with `{"v":1,"host":`.
    private func dispatch(_ envelopeJSON: String) {
        if envelopeJSON.hasPrefix("{\"v\":1,\"host\":") {
            handleHostCommand(envelopeJSON)
            return
        }
        let script = "window.__skriveDispatch(\(JSEscape.stringLiteral(envelopeJSON)));"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Perform a `host:` command and reply on the same channel; the core
    /// turns the reply into the deferred renderer response. Done async so
    /// the core's original `handle` call returns before we re-enter it with
    /// the reply (no reentrancy into the core's request arena).
    private func handleHostCommand(_ envelopeJSON: String) {
        guard let data = envelopeJSON.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let host = obj["host"] as? String,
            let id = obj["id"] as? Int
        else { return }

        switch host {
        case "trash":
            guard let path = obj["path"] as? String else {
                reply(id: id, ok: false)
                return
            }
            DispatchQueue.main.async { [weak self] in
                var ok = true
                do {
                    try FileManager.default.trashItem(
                        at: URL(fileURLWithPath: path),
                        resultingItemURL: nil
                    )
                } catch {
                    ok = false
                }
                self?.reply(id: id, ok: ok)
            }
        case "reveal":
            // persistence:revealUserData — open the app-data dir in Finder.
            guard let path = obj["path"] as? String else {
                reply(id: id, ok: false)
                return
            }
            DispatchQueue.main.async { [weak self] in
                let ok = NSWorkspace.shared.open(URL(fileURLWithPath: path))
                self?.reply(id: id, ok: ok)
            }
        default:
            // Unknown host verb: nothing to do. Future host commands add
            // their cases here.
            break
        }
    }

    /// Reply to the core on the host channel. This is a plain request to the
    /// core (not renderer-bound), so it does not go through the delivery rule.
    private func reply(id: Int, ok: Bool) {
        handle(requestJSON: "{\"v\":1,\"host\":\"result\",\"id\":\(id),\"ok\":\(ok ? "true" : "false")}")
    }
}
