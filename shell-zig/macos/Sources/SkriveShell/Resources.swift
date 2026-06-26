import Foundation

// Locates the renderer bundle and the injected native bridge. Two modes:
//   - Bundled: inside Skrive.app, read from Contents/Resources.
//   - Dev: env vars point at the repo's build outputs, so `swift run`
//     works without assembling a .app first.
// See shell-zig/README.md for the env-var contract.
enum Resources {
    private static var env: [String: String] {
        ProcessInfo.processInfo.environment
    }

    /// Directory the webview is granted read access to (the renderer root).
    static func rendererRootURL() -> URL? {
        if let dir = env["SKRIVE_RENDERER_DIR"] {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        return Bundle.main.resourceURL?
            .appendingPathComponent("renderer", isDirectory: true)
    }

    static func rendererIndexURL() -> URL? {
        rendererRootURL()?.appendingPathComponent("index.html")
    }

    /// Dev-server origin for Native HMR. When SKRIVE_DEV_URL is set the host
    /// loads it instead of the bundled renderer, so `vite dev` drives the real
    /// WKWebView with HMR. The native bridge is injected via WKUserScript
    /// regardless of origin, so window.skrive still works against the dev
    /// server. Loopback (localhost / 127.0.0.1) is ATS-exempt, so http needs no
    /// Info.plist allowance. Never set in release builds.
    static func devURL() -> URL? {
        guard let raw = env["SKRIVE_DEV_URL"], !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    /// Project root the asset scheme serves images from. In the spike this
    /// is the bundled sample project (canned data otherwise has no disk).
    static func projectRootURL() -> URL? {
        if let dir = env["SKRIVE_PROJECT_DIR"] {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        return Bundle.main.resourceURL?
            .appendingPathComponent("project", isDirectory: true)
    }

    /// Source of the injected native bridge (bundled IIFE). Empty string
    /// if missing — the host still launches so the failure is visible in
    /// the window rather than as a silent crash.
    static func bridgeJS() -> String {
        let url: URL?
        if let path = env["SKRIVE_BRIDGE_JS"] {
            url = URL(fileURLWithPath: path)
        } else {
            url = Bundle.main.url(forResource: "native-bridge", withExtension: "js")
        }
        guard let url, let source = try? String(contentsOf: url, encoding: .utf8)
        else { return "" }
        return source
    }

    /// `config_json` handed to the Zig core at create. Minimal in Stage 1;
    /// Stage 2 fills in the app-data dir and markup extension set.
    static func configJSON() -> String {
        let appData = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Skrive", isDirectory: true)
            .path ?? ""
        let escaped = appData.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"appDataDir\":\"\(escaped)\"}"
    }
}
