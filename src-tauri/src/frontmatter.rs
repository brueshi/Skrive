//! YAML frontmatter parsing for Markdown files.
//!
//! A frontmatter block is a YAML document fenced by `---` on the first line and
//! a closing `---` (or `...`) line. We parse it into a `serde_json::Value` so the
//! frontend can introspect arbitrary user-defined fields without us having to
//! commit to a fixed schema in Rust.

use crate::error::{Error, Result};
use serde_json::{Map, Value};

/// Serialize a frontmatter map back into a YAML block suitable for
/// prepending to a Markdown body. Returns the empty string for an empty
/// map so callers can unconditionally concatenate the result with a body
/// and get a clean file either way.
///
/// The output always ends with a newline after the closing `---` fence,
/// which matches how `parse()` strips the opening fence and leading
/// blank line. Round-tripping a file through `parse` → `serialize`
/// produces a byte-equivalent frontmatter block for every input we care
/// about (modulo YAML normalization — quote style, flow vs block, etc.
/// are serde_yaml_ng's choice, not ours).
///
/// Key ordering is whatever `serde_json::Map` iterates in. With the
/// default feature set that's alphabetical via `BTreeMap`; if we later
/// enable `serde_json/preserve_order` to honor user-authored order, the
/// output adapts with no signature change here.
pub fn serialize(frontmatter: &Map<String, Value>) -> Result<String> {
    if frontmatter.is_empty() {
        return Ok(String::new());
    }

    let value = Value::Object(frontmatter.clone());
    let yaml = serde_yaml_ng::to_string(&value)
        .map_err(|e| Error::Frontmatter(e.to_string()))?;

    // `serde_yaml_ng::to_string` already terminates each line with `\n`,
    // so we wrap with `---\n` / `---\n` and rely on the trailing newline
    // that serde produced to sit cleanly before the closing fence.
    let mut out = String::with_capacity(yaml.len() + 8);
    out.push_str("---\n");
    out.push_str(&yaml);
    if !yaml.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("---\n");
    Ok(out)
}

/// Result of splitting a Markdown file into its frontmatter block and body.
#[derive(Debug, Clone)]
pub struct ParsedDocument {
    /// Parsed YAML frontmatter as a JSON object. Always an object — scalar or
    /// sequence frontmatter is rejected because the project schema is field-based.
    pub frontmatter: Map<String, Value>,
    /// The Markdown body with the frontmatter block removed. Leading newlines
    /// after the closing fence are preserved so byte offsets in the body match
    /// what the editor sees.
    pub body: String,
}

/// Split a Markdown source into its frontmatter and body.
///
/// We try very hard *not* to error. Markdown in the wild uses `---` as a
/// horizontal rule all the time, and every such file has a sequence of
/// characters at its top that *structurally* looks like our fence pattern
/// but isn't intended as YAML. If we fail loudly on any of those files the
/// whole project scan fails and the user can't open the directory. So:
///
///   - No opening fence → whole source is body.
///   - Opening fence but no closing fence → whole source is body.
///   - Empty body between fences → empty frontmatter, body after the close.
///   - Syntactically invalid YAML between fences → whole source is body.
///   - Valid YAML that isn't a mapping (scalar or sequence) → whole source is body.
///   - Valid YAML mapping → frontmatter map + body after the close.
///
/// The function still returns `Result` so callers can distinguish I/O
/// failures from parse state, but in practice the lenient fallback means
/// a real `Error::Frontmatter` rarely escapes this module.
pub fn parse(source: &str) -> Result<ParsedDocument> {
    let Some(rest) = strip_opening_fence(source) else {
        return Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: source.to_string(),
        });
    };

    let Some((yaml, body)) = split_at_closing_fence(rest) else {
        // Opening fence with no closing fence — most likely a `---` that's
        // meant as a horizontal rule but happens to be at byte zero.
        return Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: source.to_string(),
        });
    };

    if yaml.trim().is_empty() {
        return Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: body.to_string(),
        });
    }

    // Attempt the YAML parse. Any failure falls back to "treat the whole
    // source as body" rather than bubbling up — the cost of being too
    // lenient here is that a file with genuinely broken frontmatter loads
    // with no frontmatter visible to the structured system (it's still
    // in the body, the user sees it in the editor), which is strictly
    // better than refusing to open the project at all.
    let value: Value = match serde_yaml_ng::from_str(yaml) {
        Ok(v) => v,
        Err(_) => {
            return Ok(ParsedDocument {
                frontmatter: Map::new(),
                body: source.to_string(),
            });
        }
    };

    match value {
        Value::Object(map) => Ok(ParsedDocument {
            frontmatter: map,
            body: body.to_string(),
        }),
        // `null` frontmatter (`---\n\n---\n`) is equivalent to an empty map.
        Value::Null => Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: body.to_string(),
        }),
        // Scalar or sequence at the top level means the `---` was almost
        // certainly a horizontal rule or a setext heading underline rather
        // than a frontmatter fence. Fall back to whole-source-as-body.
        _ => Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: source.to_string(),
        }),
    }
}

/// Strip an opening `---\n` fence and return the remainder, or `None` if there
/// is no fence at byte zero.
fn strip_opening_fence(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("---")?;
    // The fence must be followed by a newline (LF or CRLF).
    if let Some(rest) = rest.strip_prefix('\n') {
        Some(rest)
    } else {
        rest.strip_prefix("\r\n")
    }
}

/// Find the closing `---` or `...` fence and return `(yaml_block, body_after_fence)`.
fn split_at_closing_fence(rest: &str) -> Option<(&str, &str)> {
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        if trimmed == "---" || trimmed == "..." {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((yaml, body));
        }
        offset += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_frontmatter() {
        let src = "---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n";
        let parsed = parse(src).unwrap();
        assert_eq!(parsed.frontmatter["title"], Value::String("Hello".into()));
        assert_eq!(parsed.body, "# Body\n");
    }

    #[test]
    fn no_frontmatter_returns_empty_map() {
        let parsed = parse("# Just a heading\n").unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, "# Just a heading\n");
    }

    #[test]
    fn unterminated_fence_is_treated_as_body() {
        let src = "---\ntitle: oops\n# Body without closing fence\n";
        let parsed = parse(src).unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, src);
    }

    #[test]
    fn empty_frontmatter_is_allowed() {
        let parsed = parse("---\n---\n# Body\n").unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, "# Body\n");
    }

    #[test]
    fn non_mapping_fence_falls_back_to_body() {
        // A sequence-typed "fence" is almost certainly a horizontal rule
        // that happens to look like a frontmatter block to our simple
        // structural scanner. We return no frontmatter and the original
        // source as the body rather than erroring.
        let src = "---\n- one\n- two\n---\nreal body\n";
        let parsed = parse(src).unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, src);
    }

    #[test]
    fn malformed_yaml_fence_falls_back_to_body() {
        // Invalid YAML between fences — same story: treat the whole source
        // as body instead of failing the project scan.
        let src = "---\nthis: is : not : yaml\n---\nbody\n";
        let parsed = parse(src).unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, src);
    }

    #[test]
    fn horizontal_rule_near_top_is_not_frontmatter() {
        // A common real-world case: a document that starts with a horizontal
        // rule separating an author note from the body. The first `---` looks
        // like an opening fence, the second `---` looks like a closing fence,
        // and the prose between them is obviously not YAML.
        let src = "---\nA short note from the author.\n---\n\n# The Body\n";
        let parsed = parse(src).unwrap();
        assert!(parsed.frontmatter.is_empty());
        assert_eq!(parsed.body, src);
    }

    #[test]
    fn serialize_empty_map_is_empty_string() {
        let out = serialize(&Map::new()).unwrap();
        assert_eq!(out, "");
    }

    #[test]
    fn serialize_scalar_values() {
        let mut map = Map::new();
        map.insert("title".into(), Value::String("Hello".into()));
        map.insert("draft".into(), Value::Bool(true));
        let out = serialize(&map).unwrap();
        // serde_yaml_ng emits strings without quotes when unambiguous,
        // and booleans as `true` / `false`.
        assert!(out.starts_with("---\n"));
        assert!(out.ends_with("---\n"));
        assert!(out.contains("title: Hello"));
        assert!(out.contains("draft: true"));
    }

    #[test]
    fn serialize_array_values() {
        let mut map = Map::new();
        map.insert(
            "tags".into(),
            Value::Array(vec![
                Value::String("a".into()),
                Value::String("b".into()),
            ]),
        );
        let out = serialize(&map).unwrap();
        assert!(out.contains("tags:"));
        // The exact flow vs block layout is serde_yaml_ng's choice — we
        // just need the elements present in order.
        assert!(out.contains("- a"));
        assert!(out.contains("- b"));
    }

    #[test]
    fn round_trip_preserves_logical_content() {
        let original = "---\ntitle: Hello World\ntags:\n- a\n- b\n---\n# Body\n";
        let parsed = parse(original).unwrap();
        let reserialized = serialize(&parsed.frontmatter).unwrap();
        // Parse the serialized block again and compare the maps — equivalence
        // at the logical level is what we promise, not byte equivalence.
        let reparsed = parse(&format!("{}{}", reserialized, parsed.body)).unwrap();
        assert_eq!(reparsed.frontmatter, parsed.frontmatter);
        assert_eq!(reparsed.body, parsed.body);
    }

    #[test]
    fn round_trip_no_frontmatter_stays_empty() {
        let original = "# Just a heading\n\nSome prose.\n";
        let parsed = parse(original).unwrap();
        let reserialized = serialize(&parsed.frontmatter).unwrap();
        assert_eq!(reserialized, "");
    }
}
