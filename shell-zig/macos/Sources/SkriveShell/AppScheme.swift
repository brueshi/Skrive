import Foundation
import WebKit

// Custom-scheme serving for the renderer bundle (1.2 bake-off candidate).
// A custom scheme gives the app a stable, same-origin context where ES
// module scripts and module workers load — which a file:// origin does
// not (the 1.1 finding). It is NOT a secure context (survey §2), but every
// secure-context-gated API the renderer used was moved to the bridge in
// Stage 0.3, so that does not bite here.
//
// Path safety: requests are resolved under the renderer root and rejected
// if they escape it. The renderer bundle is trusted, but the handler also
// serves attacker-influenced asset paths in later stages, so containment
// is enforced from the start.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "skrive-app"
    static let host = "app"
    static var indexURL: URL {
        URL(string: "\(scheme)://\(host)/index.html")!
    }

    private let root: URL

    init(rendererRoot: URL) {
        self.root = rendererRoot.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        var relPath = url.path
        if relPath.hasPrefix("/") { relPath.removeFirst() }
        if relPath.isEmpty { relPath = "index.html" }

        let target = root.appendingPathComponent(relPath).standardizedFileURL
        // Containment: the resolved path must stay under the renderer root.
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else {
            respond(task, url: url, status: 403, data: Data(), mime: "text/plain")
            return
        }

        guard let data = try? Data(contentsOf: target) else {
            respond(task, url: url, status: 404, data: Data(), mime: "text/plain")
            return
        }
        respond(task, url: url, status: 200, data: data, mime: Self.mime(for: target))
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(
        _ task: WKURLSchemeTask,
        url: URL,
        status: Int,
        data: Data,
        mime: String
    ) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            // Same-origin app; permissive CORS keeps module/worker fetches
            // unblocked under the custom origin.
            "Access-Control-Allow-Origin": "*"
        ]
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    // ES modules are rejected unless served with a JavaScript MIME type, so
    // this map is load-bearing, not cosmetic.
    private static func mime(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "map": return "application/json"
        default: return "application/octet-stream"
        }
    }
}
