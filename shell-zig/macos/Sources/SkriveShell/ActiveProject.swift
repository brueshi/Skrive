import Foundation

/// The currently-open project root, shared between `CoreBridge` (which sets
/// it when the renderer opens a project via `project:snapshot`) and
/// `AssetSchemeHandler` (which serves `skrive-asset://` images from it).
/// Lock-guarded because the scheme handler and the bridge may touch it from
/// different contexts; both touch it rarely.
final class ActiveProject: @unchecked Sendable {
    private let lock = NSLock()
    private var _rootPath: String?

    var rootPath: String? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _rootPath
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _rootPath = newValue
        }
    }
}
