import AppKit
import Foundation

/// The host half of Skrive's spelling oracle (`spell:*`).
///
/// The writing surface paints its own squiggles as decorations — WebKit's native
/// spelling markers are bound to text nodes and die on every model-first
/// re-render, which is why the attribute stays off — but the *judgement* of what
/// is misspelled belongs to the platform. Going through NSSpellChecker means
/// Skrive inherits the writer's system languages, the words they have taught
/// their Mac, and Apple's suggestion quality, for no bundle weight and no
/// dictionary of our own to maintain.
///
/// Checking uses `requestChecking`, the asynchronous API: it does the work off
/// the host's main thread and calls back when done, so a settled edit in a long
/// document never stalls the window (and never risks a cold-start XPC spin-up on
/// the main thread). Suggestions and ignore are user-initiated one-shots and stay
/// synchronous on main, where AppKit wants them.
@MainActor
final class SpellingService {
    /// One tag for this window's checker session. It is what makes `ignore`
    /// meaningful: ignored words are scoped to a spell-document, so "ignore"
    /// lasts the session without touching the user's system dictionary.
    private let documentTag = NSSpellChecker.uniqueSpellDocumentTag()

    /// One block of prose to check. Sendable because it crosses onto the
    /// checker's background queue with the request.
    struct Request: Sendable {
        let id: String
        let text: String
    }

    /// A misspelled span as a half-open `[start, end)` range in UTF-16 code
    /// units — the units both `NSString` and JS strings are indexed by, so the
    /// renderer can slice the exact string it sent with no conversion.
    struct Span: Sendable {
        let start: Int
        let end: Int
    }

    /// Accumulates one batch's per-request answers and fires once they are all
    /// in. `@unchecked Sendable` is deliberate and narrow: the checker calls
    /// back on an arbitrary thread, so the box must cross threads, but every
    /// mutation below happens inside a `DispatchQueue.main.async` hop — the box
    /// is only ever touched on the main queue.
    private final class Collector: @unchecked Sendable {
        private let expected: Int
        private let completion: ([String: [Span]]) -> Void
        private var answers: [String: [Span]] = [:]

        init(expected: Int, completion: @escaping ([String: [Span]]) -> Void) {
            self.expected = expected
            self.completion = completion
        }

        /// Record one request's answer; fire the batch completion on the last.
        /// A duplicate id would under-count, so requests are de-duplicated by
        /// the caller (the renderer keys its dirty set by block id).
        func add(id: String, spans: [Span]) {
            answers[id] = spans
            if answers.count >= expected { completion(answers) }
        }
    }

    /// Check a batch of blocks. `completion` runs on the main actor, once, with
    /// an answer for every request (an empty span list means "checks clean").
    func check(
        _ requests: [Request],
        completion: @escaping @MainActor ([String: [Span]]) -> Void
    ) {
        guard !requests.isEmpty else {
            completion([:])
            return
        }
        let collector = Collector(expected: requests.count) { answers in
            MainActor.assumeIsolated { completion(answers) }
        }
        let types = NSTextCheckingResult.CheckingType.spelling.rawValue
        for request in requests {
            let length = (request.text as NSString).length
            // Empty text answers itself — asking the checker would cost a round
            // trip to learn nothing.
            guard length > 0 else {
                collector.add(id: request.id, spans: [])
                continue
            }
            NSSpellChecker.shared.requestChecking(
                of: request.text,
                range: NSRange(location: 0, length: length),
                types: types,
                options: nil,
                inSpellDocumentWithTag: documentTag
            ) { _, results, _, _ in
                // Background thread. Reduce to plain values here: an
                // NSTextCheckingResult is not Sendable and must not cross.
                let spans: [Span] = results.compactMap { result in
                    guard result.resultType == .spelling else { return nil }
                    let range = result.range
                    guard range.length > 0 else { return nil }
                    return Span(
                        start: range.location,
                        end: range.location + range.length
                    )
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        collector.add(id: request.id, spans: spans)
                    }
                }
            }
        }
    }

    /// Correction candidates for one misspelled word, best first. Empty when the
    /// checker has nothing to offer (which the renderer renders as a disabled
    /// "No suggestions" row rather than an empty menu).
    func suggestions(for word: String) -> [String] {
        let length = (word as NSString).length
        guard length > 0 else { return [] }
        return NSSpellChecker.shared.guesses(
            forWordRange: NSRange(location: 0, length: length),
            in: word,
            language: nil,
            inSpellDocumentWithTag: documentTag
        ) ?? []
    }

    /// Suppress a word for this session only, scoped to our spell-document tag.
    func ignore(_ word: String) {
        guard !word.isEmpty else { return }
        NSSpellChecker.shared.ignoreWord(word, inSpellDocumentWithTag: documentTag)
    }
}
