import XCTest
import JavaScriptCore
@testable import SkriveShellKit

// The delivery-rule escaper is security-normative (master plan, Part I), so
// it gets a real unit test: every adversarial input must round-trip
// byte-identical through `window.__skriveDispatch(<literal>)`, and a
// breakout payload must stay inert data, never executing. Evaluated in a
// real JS engine (JavaScriptCore), not asserted against a hand-rolled
// expectation, so the test catches escaping bugs the way WebKit would.
final class JSEscapeTests: XCTestCase {
    private func roundTrip(_ input: String, file: StaticString = #filePath, line: UInt = #line) {
        let ctx = JSContext()!
        let literal = JSEscape.stringLiteral(input)
        let value = ctx.evaluateScript(literal)
        XCTAssertNil(ctx.exception, "literal threw: \(String(describing: ctx.exception))", file: file, line: line)
        XCTAssertEqual(value?.toString(), input, "round-trip mismatch", file: file, line: line)
    }

    func testByteIdenticalAcrossAdversarialInputs() {
        let cases = [
            "</script><script>window.x=1</script>",
            "back`tick` and ${template}",
            "quote \" backslash \\ slash /",
            "line\u{2028}sep\u{2029}para",
            "newline\ntab\tcr\r",
            "control\u{00}\u{01}\u{1F}",
            "emoji \u{1F389} accents caf\u{E9}",
            "<!-- comment --> </SCRIPT >",
            ""
        ]
        for input in cases { roundTrip(input) }
    }

    func testBreakoutPayloadStaysInert() {
        // If escaping let the string terminate early, this would assign the
        // global. Correct escaping keeps it a single inert string.
        let ctx = JSContext()!
        ctx.evaluateScript("var pwned = 0;")
        let payload = "\"; pwned = 1; \""
        let literal = JSEscape.stringLiteral(payload)
        let result = ctx.evaluateScript("var r = \(literal); r;")
        XCTAssertNil(ctx.exception)
        XCTAssertEqual(result?.toString(), payload)
        XCTAssertEqual(ctx.evaluateScript("pwned")?.toInt32(), 0)
    }
}
