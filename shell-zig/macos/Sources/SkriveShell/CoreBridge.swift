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
    private let activeProject: ActiveProject

    init(webView: WKWebView, configJSON: String, activeProject: ActiveProject) {
        self.webView = webView
        self.activeProject = activeProject
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

    /// Renderer -> shell. Host-owned commands (native dialogs, open-external,
    /// clipboard, app) are handled in Swift and replied directly; everything
    /// else forwards to the Zig core verbatim (Part I: "the host owns X,
    /// forwards the rest"). Parsing every request is cheap — saves are
    /// debounced, not per-keystroke.
    func handle(requestJSON: String) {
        if let data = requestJSON.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cmd = obj["cmd"] as? String,
            let id = obj["id"] as? Int
        {
            let payload = obj["payload"] as? [String: Any] ?? [:]
            if routeHostOwned(cmd: cmd, id: id, payload: payload) { return }
            // Track the active project root for asset serving — the snapshot's
            // root is the project the renderer just opened.
            if cmd == "project:snapshot", let root = payload["root"] as? String {
                activeProject.rootPath = root
            }
        }
        guard let core else { return }
        requestJSON.withCString { skrive_core_handle(core, $0) }
    }

    /// Handle a host-owned command, returning true if it was. Future host
    /// commands (links:openExternal, clipboard:*, app:*) add their cases here.
    private func routeHostOwned(cmd: String, id: Int, payload: [String: Any]) -> Bool {
        switch cmd {
        case "project:openDialog":
            handleOpenDialog(id: id)
            return true
        case "links:openExternal":
            handleOpenExternal(id: id, payload: payload)
            return true
        case "clipboard:writeRich":
            handleClipboardWriteRich(id: id, payload: payload)
            return true
        case "clipboard:writeText":
            handleClipboardWriteText(id: id, payload: payload)
            return true
        case "clipboard:readText":
            handleClipboardReadText(id: id)
            return true
        case "app:flushComplete":
            // The renderer's pre-quit flush ack — fire-and-forget, no reply.
            finishFlush()
            return true
        default:
            return false
        }
    }

    /// Open an external URL in the OS default handler, gated by the Part I
    /// scheme allowlist. A disallowed scheme is a silent no-op (the contract
    /// returns void either way).
    private func handleOpenExternal(id: Int, payload: [String: Any]) {
        if let urlString = payload["url"] as? String,
            let url = URL(string: urlString),
            let scheme = url.scheme?.lowercased(),
            ["http", "https", "mailto", "tel", "skrive"].contains(scheme)
        {
            NSWorkspace.shared.open(url)
        }
        replyToRenderer(id: id, result: [:])
    }

    /// Write rich (HTML) + plain flavors to the pasteboard in one shot.
    private func handleClipboardWriteRich(id: Int, payload: [String: Any]) {
        let pb = NSPasteboard.general
        pb.clearContents()
        if let html = payload["html"] as? String { pb.setString(html, forType: .html) }
        if let text = payload["text"] as? String { pb.setString(text, forType: .string) }
        replyToRenderer(id: id, result: [:])
    }

    private func handleClipboardWriteText(id: Int, payload: [String: Any]) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(payload["text"] as? String ?? "", forType: .string)
        replyToRenderer(id: id, result: [:])
    }

    private func handleClipboardReadText(id: Int) {
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        replyToRenderer(id: id, result: ["text": text])
    }

    /// Folder picker (NSOpenPanel). Replies with the chosen path, or null on
    /// cancel — matching the contract's `openDialog(): Promise<string | null>`.
    private func handleOpenDialog(id: Int) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.title = "Open project"
        panel.prompt = "Open"
        let chosen: String? = panel.runModal() == .OK ? panel.url?.path : nil
        replyToRenderer(id: id, result: ["path": chosen ?? NSNull()])
    }

    /// Build and deliver a success response envelope to the renderer. Key
    /// order is irrelevant — the renderer reads the envelope by key.
    private func replyToRenderer(id: Int, result: [String: Any]) {
        let envelope: [String: Any] = ["v": 1, "id": id, "ok": true, "result": result]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
            let json = String(data: data, encoding: .utf8)
        else { return }
        dispatch(json)
    }

    /// Deliver an unsolicited event envelope to the renderer.
    private func emitEvent(_ event: String) {
        let envelope: [String: Any] = ["v": 1, "event": event, "payload": [:]]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
            let json = String(data: data, encoding: .utf8)
        else { return }
        dispatch(json)
    }

    // MARK: - Pre-quit flush handshake

    private var flushCompletion: (() -> Void)?

    /// Ask the renderer to flush pending saves before quit, then call
    /// `completion` on its `app:flushComplete` ack or after a 2s backstop
    /// (whichever comes first), exactly once.
    func beginFlush(completion: @escaping () -> Void) {
        flushCompletion = completion
        emitEvent("app:flush-before-quit")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.finishFlush()
        }
    }

    private func finishFlush() {
        guard let completion = flushCompletion else { return }
        flushCompletion = nil
        completion()
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
