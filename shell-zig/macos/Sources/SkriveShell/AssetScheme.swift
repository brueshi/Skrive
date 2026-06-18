import Foundation
import WebKit

// Serves project image assets over `skrive-asset://asset/<rel-path>`,
// matching the renderer's imageResolver (app/src/lib/preview/imageResolver.ts)
// and the Electron asset protocol (shell/src/main/asset-protocol.ts). This is
// a SEPARATE origin from the app scheme: the 1.2 checklist's no-mixed-content
// row is exactly whether a skrive-app:// page can load images from this
// skrive-asset:// origin.
//
// Path safety (Part I): the decoded path is resolved under the ACTIVE
// project root (the project the renderer last opened) and rejected if it
// escapes — both root and target are canonicalized via
// `resolvingSymlinksInPath`, so an in-root symlink that jumps outside is
// caught, not just lexical `..` traversal.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "skrive-asset"

    private let activeProject: ActiveProject

    init(activeProject: ActiveProject) {
        self.activeProject = activeProject
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        // No project open yet -> nothing to serve.
        guard let rootPath = activeProject.rootPath else {
            respond(task, url: url, status: 404, data: Data(), mime: "text/plain")
            return
        }
        let projectRoot = URL(fileURLWithPath: rootPath).resolvingSymlinksInPath()

        // URL is skrive-asset://asset/<encoded path>; the leading host
        // ("asset") is dropped, the path is percent-decoded per segment.
        var rel = url.path
        if rel.hasPrefix("/") { rel.removeFirst() }
        guard let decoded = rel.removingPercentEncoding, !decoded.isEmpty,
              !decoded.contains("\0") else {
            respond(task, url: url, status: 400, data: Data(), mime: "text/plain")
            return
        }

        let target = projectRoot.appendingPathComponent(decoded).resolvingSymlinksInPath()
        guard target.path == projectRoot.path
            || target.path.hasPrefix(projectRoot.path + "/") else {
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
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*"
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private static func mime(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "avif": return "image/avif"
        case "bmp": return "image/bmp"
        default: return "application/octet-stream"
        }
    }
}
