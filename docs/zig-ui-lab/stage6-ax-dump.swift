// ax-dump.swift — walk a process's accessibility tree from outside and print
// roles / labels / values / frames. Scratchpad-tier verification helper for
// the zig-ui lab's Stage 6 AX bridge (the winid helper's sibling).
//
//   swift ax-dump.swift <pid>
//
// Needs Accessibility trust for the *invoking* process (Terminal / the agent
// shell); prints NOT-TRUSTED and exits 2 if absent so the caller can hand
// the run to a trusted terminal instead.
import ApplicationServices
import AppKit

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return err == .success ? v : nil
}

func str(_ v: CFTypeRef?) -> String? {
    guard let v = v else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() { return (v as! String) }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return "\(v as! NSNumber)" }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return (v as! Bool) ? "1" : "0" }
    return nil
}

func frameOf(_ el: AXUIElement) -> String {
    var out = ""
    if let pv = attr(el, kAXPositionAttribute), CFGetTypeID(pv) == AXValueGetTypeID() {
        var pt = CGPoint.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
        out += String(format: "(%.1f, %.1f", pt.x, pt.y)
    }
    if let sv = attr(el, kAXSizeAttribute), CFGetTypeID(sv) == AXValueGetTypeID() {
        var sz = CGSize.zero
        AXValueGetValue(sv as! AXValue, .cgSize, &sz)
        out += String(format: ", %.1f x %.1f)", sz.width, sz.height)
    }
    return out
}

func walk(_ el: AXUIElement, _ depth: Int) {
    let role = str(attr(el, kAXRoleAttribute)) ?? "?"
    let label = str(attr(el, kAXDescriptionAttribute)) ?? ""
    let title = str(attr(el, kAXTitleAttribute)) ?? ""
    let value = str(attr(el, kAXValueAttribute))
    let enabled = str(attr(el, kAXEnabledAttribute))
    let indent = String(repeating: "  ", count: depth)
    var line = "\(indent)\(role)"
    if !label.isEmpty { line += "  label=\"\(label)\"" }
    if !title.isEmpty { line += "  title=\"\(title)\"" }
    if let v = value { line += "  value=\(v)" }
    if let e = enabled, e == "0" { line += "  DISABLED" }
    let f = frameOf(el)
    if !f.isEmpty { line += "  frame=\(f)" }
    print(line)
    if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for k in kids { walk(k, depth + 1) }
    }
}

guard CommandLine.arguments.count > 1, let pidArg = Int32(CommandLine.arguments[1]) else {
    print("usage: swift ax-dump.swift <pid>")
    exit(1)
}
guard AXIsProcessTrusted() else {
    print("NOT-TRUSTED")
    exit(2)
}
walk(AXUIElementCreateApplication(pidArg), 0)
