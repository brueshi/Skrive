// Dragging the window by the renderer's topbar (SKR-240).
//
// The renderer marks its drag lane with `-webkit-app-region: drag`, a Chromium
// extension that WKWebView does not implement and ignores in silence. The Windows
// host gets the behavior free (WebView2 is Chromium); this host has to ask AppKit.
//
// `NSWindow.performDrag` needs the mouse-down that began the gesture. The obvious
// source — `NSApp.currentEvent`, which is what Tauri and Ghostty read — is NOT
// reliable behind an out-of-process WKWebView. The renderer's mousedown has to cross
// the process boundary before we see it, and on a Force Touch trackpad AppKit has by
// then dequeued a `.pressure` event (raw 34); `currentEvent` points at that, not at
// the click. Measured in the real shell: every drag reported `event=34` and bailed.
//
// So the host remembers the last left mouse-down itself, via a local event monitor
// that observes and never consumes. `currentEvent` is still preferred when it really
// is a mouse event — that is the freshest possible answer — and the remembered event
// is the fallback that makes it work on a trackpad.

import AppKit

@MainActor
enum WindowDrag {
    private static var monitor: Any?
    private static var lastMouseDown: NSEvent?

    /// Start observing left mouse-downs. Called once, at launch. The monitor returns
    /// every event unchanged: it is a tap on the stream, not a filter, so nothing
    /// downstream (the webview, the traffic lights, the menu bar) loses a click.
    static func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { event in
            lastMouseDown = event
            return event
        }
    }

    /// Drag `window` from the mouse-down the renderer is reporting.
    ///
    /// `performDrag` runs its own event loop until mouse-up, so this returns only when
    /// the drag is over. Passing an event that belongs to another window would drag
    /// from the wrong origin, hence the identity check on the fallback.
    static func start(in window: NSWindow) {
        if let current = NSApp.currentEvent, current.type == .leftMouseDown || current.type == .leftMouseDragged {
            window.performDrag(with: current)
            return
        }
        guard let down = lastMouseDown, down.window === window else { return }
        window.performDrag(with: down)
    }

    /// Double-click on the drag lane. macOS lets the user choose what that means
    /// (System Settings > Desktop & Dock > "Double-click a window's title bar to"),
    /// so read the preference rather than assuming zoom. An unset default is Maximize.
    static func toggleZoom(in window: NSWindow) {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize":
            window.miniaturize(nil)
        case "None":
            break
        default:
            window.zoom(nil)
        }
    }
}
