import Foundation

// The renderer delivery rule (master plan, Part I, security-normative).
// Responses and events reach the renderer ONLY as
// `window.__skriveDispatch(<JSON string literal>)` — the envelope is
// JSON-encoded by the core, then escaped here as a JavaScript string
// literal. Payload fields (file contents) are never interpolated into a
// script; this is what stops a Markdown file from becoming script.
enum JSEscape {
    /// Wrap an arbitrary string as a double-quoted JS string literal whose
    /// parsed value is byte-identical to the input. Escapes the structural
    /// characters plus U+2028/U+2029 (legal in JSON, illegal unescaped in
    /// JS) and `<` (neutralizes `</script>` and `<!--`).
    static func stringLiteral(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "<": out += "\\u003C"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04X", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
