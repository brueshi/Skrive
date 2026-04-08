//! YAML frontmatter parsing for Markdown files.
//!
//! A frontmatter block is a YAML document fenced by `---` on the first line and
//! a closing `---` (or `...`) line. We parse it into a `serde_json::Value` so the
//! frontend can introspect arbitrary user-defined fields without us having to
//! commit to a fixed schema in Rust.

use crate::error::{Error, Result};
use serde_json::{Map, Value};

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
/// Files without a frontmatter fence return an empty map and the original source
/// as the body. Malformed YAML is reported as `Error::Frontmatter`.
pub fn parse(source: &str) -> Result<ParsedDocument> {
    let Some(rest) = strip_opening_fence(source) else {
        return Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: source.to_string(),
        });
    };

    let Some((yaml, body)) = split_at_closing_fence(rest) else {
        // Opening fence with no closing fence — treat as plain Markdown rather
        // than throwing, since this is what most other Markdown tools do.
        return Ok(ParsedDocument {
            frontmatter: Map::new(),
            body: source.to_string(),
        });
    };

    let frontmatter = if yaml.trim().is_empty() {
        Map::new()
    } else {
        let value: Value = serde_yaml_ng::from_str(yaml)
            .map_err(|e| Error::Frontmatter(e.to_string()))?;
        match value {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => {
                return Err(Error::Frontmatter(
                    "frontmatter must be a YAML mapping".to_string(),
                ))
            }
        }
    };

    Ok(ParsedDocument {
        frontmatter,
        body: body.to_string(),
    })
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
    fn rejects_non_mapping_frontmatter() {
        let err = parse("---\n- one\n- two\n---\n").unwrap_err();
        assert!(matches!(err, Error::Frontmatter(_)));
    }
}
