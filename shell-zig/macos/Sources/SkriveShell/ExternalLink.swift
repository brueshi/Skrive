import AppKit
import Foundation

/// Single source of truth for the external-link policy, shared by the
/// `links:openExternal` bridge command and the WKWebView navigation/UI
/// delegates (4.0 link policy). Centralized so the security-relevant
/// allowlist exists in exactly one place: an attacker-controlled link in a
/// note can never drive the host to open an arbitrary scheme.
enum ExternalLink {
    /// Part I scheme allowlist: web, mail, tel, and Skrive's own deep-link
    /// scheme. Anything outside it is refused.
    static let allowedSchemes: Set<String> = ["http", "https", "mailto", "tel", "skrive"]

    /// Open `url` in the OS default handler iff its scheme is allowed.
    /// Returns whether it was opened; `false` is a safe no-op (refused scheme
    /// or unparseable URL).
    @discardableResult
    static func open(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
            allowedSchemes.contains(scheme)
        else { return false }
        NSWorkspace.shared.open(url)
        return true
    }
}
