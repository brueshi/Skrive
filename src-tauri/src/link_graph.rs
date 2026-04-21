//! Internal link graph for a Skrive project.
//!
//! Each edge carries the byte range, line, and column of the link in its
//! source document. Three link styles are tracked: inline `[text](url)`,
//! wiki `[[Name]]`, and reference-style both as `[label]: target`
//! definitions and `[text][label]` / `[shortcut]` uses. The positional
//! data is what drives Phase 3.1's rename-with-references — on rename we
//! rewrite the `byte_range` of every rewriteable edge pointing at the
//! moved file.
//!
//! Reference-style parsing splits across two paths. pulldown-cmark's
//! offset iterator resolves every reference *use* against the document's
//! internal definition table and gives us its byte span. Definitions
//! themselves aren't emitted as events, so a small hand-rolled line
//! scanner finds `[label]: target` lines at CommonMark block boundaries
//! and records the target's byte range. Wiki links sit outside
//! CommonMark entirely; the existing hand-rolled sweep handles those.

use crate::frontmatter::ParsedDocument;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::path::{Path, PathBuf};

/// Forward and back link tables for the entire project. Keys are
/// project-relative paths in forward-slash form.
#[derive(Debug, Default, Clone)]
pub struct LinkGraph {
    forward: BTreeMap<String, Vec<Edge>>,
    /// Target path → set of source paths that link to it. Positions live
    /// on the forward-side `Edge`, so backlinks are served by walking
    /// every source's edges and filtering for `target == target`.
    backward: BTreeMap<String, BTreeSet<String>>,
}

/// A single link from `source` to `target`, carrying enough position data
/// to drive rename (byte_range) and backlinks UI (line + column + kind).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub target: LinkTarget,
    /// Byte range in the source document. Meaning depends on `kind`:
    /// - `Inline`: the range of the URL portion inside `[text](url)`.
    /// - `Wiki`: the range of the inner name inside `[[Name]]`.
    /// - `ReferenceUse`: the range of the full `[text][label]` / `[label]`
    ///   / `[label][]` span. Use sites aren't rewritten on rename, so
    ///   this is display-only.
    /// - `ReferenceDefinition`: the range of the target URL inside a
    ///   `[label]: target` definition line.
    pub byte_range: Range<usize>,
    /// 0-indexed line number.
    pub line: u32,
    /// 0-indexed *byte* column in `line`. The Phase 3.1 commands convert
    /// to UTF-16 columns at the IPC boundary; keeping bytes here matches
    /// the `byte_range` representation and avoids double-conversion.
    pub column: u32,
    pub kind: LinkKind,
}

/// A single edge target. Relative paths are project-relative, forward-
/// slash form, resolved against the source's directory. Wiki targets are
/// the inner name verbatim — filename resolution happens at lookup time,
/// not at extraction.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum LinkTarget {
    Relative(String),
    Wiki(String),
}

/// What kind of markdown construct produced this edge. Drives rename
/// rewrite rules (what part of the source line changes) and the UI's
/// choice of snippet. Serialized over the IPC wire as lowerCamelCase
/// strings so the frontend can branch on variant names without a shared
/// enum mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Inline,
    Wiki,
    ReferenceUse,
    ReferenceDefinition,
}

impl LinkGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the outgoing edges for `source`. Back-links are kept in
    /// sync: targets dropped from the edge list lose their back-pointer
    /// from `source`; new targets gain one.
    pub fn set_links(&mut self, source: &str, edges: Vec<Edge>) {
        let old_targets: BTreeSet<String> = self
            .forward
            .get(source)
            .map(|es| {
                es.iter()
                    .filter_map(|e| match &e.target {
                        LinkTarget::Relative(p) => Some(p.clone()),
                        LinkTarget::Wiki(_) => None,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let new_targets: BTreeSet<String> = edges
            .iter()
            .filter_map(|e| match &e.target {
                LinkTarget::Relative(p) => Some(p.clone()),
                LinkTarget::Wiki(_) => None,
            })
            .collect();

        for dropped in old_targets.difference(&new_targets) {
            if let Some(set) = self.backward.get_mut(dropped) {
                set.remove(source);
                if set.is_empty() {
                    self.backward.remove(dropped);
                }
            }
        }
        for added in new_targets.difference(&old_targets) {
            self.backward
                .entry(added.clone())
                .or_default()
                .insert(source.to_string());
        }

        self.forward.insert(source.to_string(), edges);
    }

    /// Drop every edge originating at `source`. Used when a file is
    /// deleted or renamed away.
    pub fn forget(&mut self, source: &str) {
        if let Some(old) = self.forward.remove(source) {
            for edge in old {
                if let LinkTarget::Relative(target) = edge.target {
                    if let Some(set) = self.backward.get_mut(&target) {
                        set.remove(source);
                        if set.is_empty() {
                            self.backward.remove(&target);
                        }
                    }
                }
            }
        }
    }

    /// The outgoing edges from `source`, if any. Phase 3.1's
    /// `get_outgoing_links` command is the first real reader.
    #[allow(dead_code)]
    pub fn outgoing(&self, source: &str) -> Option<&[Edge]> {
        self.forward.get(source).map(|v| v.as_slice())
    }

    /// The set of source paths that link to `target`. Phase 3.1's
    /// `get_backlinks` command pairs this with a per-source lookup on
    /// `outgoing()` to recover the Edge position info.
    #[allow(dead_code)]
    pub fn incoming(&self, target: &str) -> Option<&BTreeSet<String>> {
        self.backward.get(target)
    }

    /// Iterate every (source, edges) pair. Phase 3.1's `get_dead_links`
    /// walks the whole graph to find edges whose target no longer
    /// resolves to a file.
    #[allow(dead_code)]
    pub fn iter(&self) -> impl Iterator<Item = (&String, &[Edge])> {
        self.forward.iter().map(|(k, v)| (k, v.as_slice()))
    }
}

/// Extract every link from `doc` as an `Edge`. The returned vector is in
/// document order. External links (schemes, fragments) and any link
/// target that would escape the project root are skipped.
pub fn extract(doc: &ParsedDocument, source_relpath: &Path) -> Vec<Edge> {
    // Every offset we care about lives in the body, but pulldown-cmark's
    // offset iterator reports offsets *relative to the string it was
    // given*. If we wanted to point at offsets in the raw on-disk file
    // we'd need to bias by the frontmatter prefix length. We don't —
    // positions on edges are body-relative by design, because that's
    // what rename and backlinks actually operate on (both work against
    // the in-memory body, not the on-disk bytes).
    let body = &doc.body;
    let line_starts = compute_line_starts(body);

    let mut edges: Vec<Edge> = Vec::new();

    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);

    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let Event::Start(Tag::Link {
            link_type,
            dest_url,
            ..
        }) = event
        else {
            continue;
        };

        if is_external(&dest_url) {
            continue;
        }

        let kind = match link_type {
            LinkType::Inline => LinkKind::Inline,
            LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
                LinkKind::ReferenceUse
            }
            // Autolinks (`<url>`) and email autolinks are always external
            // — if they survived the `is_external` check above, skip them
            // anyway; they're not markdown links we can rename.
            _ => continue,
        };

        let Some(target) = resolve_relative(source_relpath, &dest_url) else {
            continue;
        };

        // For inline links, we narrow the Edge's byte_range to just the
        // URL slice so rename can rewrite safely. For reference uses, we
        // keep the whole span — uses aren't rewritten on rename because
        // they reference the label, not the path.
        let byte_range = match kind {
            LinkKind::Inline => {
                match find_inline_url_range(&body[range.clone()], range.start, &dest_url) {
                    Some(r) => r,
                    // Couldn't locate the URL inside the link span — skip
                    // rather than emit an edge whose range is wrong. A
                    // wrong range would corrupt a rename. Losing the
                    // edge entirely means we miss a backlink, which is
                    // the less-bad failure mode.
                    None => continue,
                }
            }
            _ => range.clone(),
        };

        let (line, column) = offset_to_line_col(&line_starts, byte_range.start);
        edges.push(Edge {
            target: LinkTarget::Relative(target),
            byte_range,
            line,
            column,
            kind,
        });
    }

    // Wiki links aren't part of CommonMark, so pulldown-cmark doesn't see
    // them. Sweep for `[[...]]` separately, matching the existing
    // pre-3.1 behavior plus position data.
    extract_wiki_links(body, &line_starts, &mut edges);

    // Reference-style *definitions* aren't events either — pulldown-cmark
    // consumes them silently into its resolution table and moves on. We
    // sweep the body for `[label]: target` lines ourselves so rename can
    // rewrite the definition when the target file moves.
    extract_ref_definitions(body, source_relpath, &line_starts, &mut edges);

    edges
}

fn is_external(dest: &str) -> bool {
    dest.starts_with('#')
        || dest.starts_with("http://")
        || dest.starts_with("https://")
        || dest.starts_with("mailto:")
        || dest.starts_with("tel:")
}

/// Normalize a relative link target into a project-relative path string
/// with forward slashes. Returns `None` when the link would escape the
/// project root.
fn resolve_relative(source_relpath: &Path, dest: &str) -> Option<String> {
    let dest_path = Path::new(dest);
    let mut joined: PathBuf =
        source_relpath.parent().map(Path::to_path_buf).unwrap_or_default();
    for component in dest_path.components() {
        match component {
            std::path::Component::ParentDir => {
                if !joined.pop() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => joined.push(part),
            std::path::Component::RootDir | std::path::Component::Prefix(_) => return None,
        }
    }
    Some(joined.to_string_lossy().replace('\\', "/"))
}

fn extract_wiki_links(body: &str, line_starts: &[usize], edges: &mut Vec<Edge>) {
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = find_subsequence(&bytes[i + 2..], b"]]") {
                let inner_start = i + 2;
                let inner_end = inner_start + end;
                let inner = &body[inner_start..inner_end];
                // Wiki links support `[[Target|Alias]]` — take the part
                // before the pipe as the target name.
                let (name, name_len_in_inner) = match inner.find('|') {
                    Some(pipe) => (&inner[..pipe], pipe),
                    None => (inner, inner.len()),
                };
                let name = name.trim();
                if !name.is_empty() {
                    let name_start = inner_start; // trim doesn't change byte offset for well-formed wiki links
                    let (line, column) = offset_to_line_col(line_starts, name_start);
                    edges.push(Edge {
                        target: LinkTarget::Wiki(name.to_string()),
                        byte_range: name_start..name_start + name_len_in_inner.min(inner.len()),
                        line,
                        column,
                        kind: LinkKind::Wiki,
                    });
                }
                i = inner_end + 2;
                continue;
            }
        }
        i += 1;
    }
}

/// Scan the body for `[label]: target` reference-style definitions. A
/// definition must start at a CommonMark block boundary (the previous
/// line is blank or it's the first line) and must not live inside a
/// fenced code block. Single-line definitions only — CommonMark also
/// permits the target to wrap onto the next line, but that form is
/// vanishingly rare in practice and shipping without it keeps the
/// scanner simple. (Add it if dogfooding trips on it.)
fn extract_ref_definitions(
    body: &str,
    source_relpath: &Path,
    line_starts: &[usize],
    edges: &mut Vec<Edge>,
) {
    let mut in_fence: Option<char> = None;
    // Either condition is enough to treat the current line as a
    // block-boundary start. Consecutive `[label]: target` definitions
    // stack into one block without needing blank lines between them —
    // that's how CommonMark works and how pulldown-cmark treats them.
    let mut prev_line_blank = true; // doc start counts as a block boundary
    let mut prev_line_was_def = false;

    for (line_idx, line_start) in line_starts.iter().enumerate() {
        let line_end = line_starts.get(line_idx + 1).copied().unwrap_or(body.len());
        // Strip the trailing '\n' (and possibly '\r') from the line slice.
        let mut line_body_end = line_end;
        if line_body_end > *line_start && body.as_bytes()[line_body_end - 1] == b'\n' {
            line_body_end -= 1;
        }
        if line_body_end > *line_start && body.as_bytes()[line_body_end - 1] == b'\r' {
            line_body_end -= 1;
        }
        let line = &body[*line_start..line_body_end];

        // Update fence state. Fences must have <=3 leading spaces.
        let trimmed = line.trim_start();
        let leading = line.len() - trimmed.len();
        if leading <= 3 {
            let fence_char = if trimmed.starts_with("```") {
                Some('`')
            } else if trimmed.starts_with("~~~") {
                Some('~')
            } else {
                None
            };
            match (in_fence, fence_char) {
                (None, Some(c)) => in_fence = Some(c),
                (Some(open_c), Some(close_c)) if open_c == close_c => {
                    let after = &trimmed[3..];
                    let extra = after.chars().take_while(|&ch| ch == open_c).count();
                    if after[extra..].trim().is_empty() {
                        in_fence = None;
                    }
                }
                _ => {}
            }
        }

        let is_blank = line.trim().is_empty();
        let mut current_is_def = false;

        if in_fence.is_none() && (prev_line_blank || prev_line_was_def) && leading <= 3 {
            if let Some((label_text, target_in_line_start, target_len, target_text)) =
                parse_ref_definition_line(line)
            {
                let _ = label_text; // label is resolved by pulldown-cmark on the use side; we only care about the target
                current_is_def = true;
                if !is_external(target_text) {
                    if let Some(resolved) = resolve_relative(source_relpath, target_text) {
                        let byte_start = *line_start + target_in_line_start;
                        let byte_range = byte_start..byte_start + target_len;
                        let (line_num, column) = offset_to_line_col(line_starts, byte_start);
                        edges.push(Edge {
                            target: LinkTarget::Relative(resolved),
                            byte_range,
                            line: line_num,
                            column,
                            kind: LinkKind::ReferenceDefinition,
                        });
                    }
                }
            }
        }

        prev_line_blank = is_blank;
        prev_line_was_def = current_is_def;
    }
}

/// Try to parse one line as a `[label]: target` reference definition.
/// Returns the label text, the column of the target inside `line`, the
/// target length, and the target text. Returns `None` if the line isn't
/// a definition or is mangled past the target.
fn parse_ref_definition_line(line: &str) -> Option<(&str, usize, usize, &str)> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    if leading > 3 {
        return None;
    }
    if !trimmed.starts_with('[') {
        return None;
    }

    let bytes = trimmed.as_bytes();
    let mut i = 1usize;
    let mut label_end: Option<usize> = None;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if i + 1 < bytes.len() => i += 2,
            b']' => {
                label_end = Some(i);
                break;
            }
            _ => i += 1,
        }
    }
    let label_end = label_end?;
    if label_end + 1 >= bytes.len() || bytes[label_end + 1] != b':' {
        return None;
    }
    let label_text = &trimmed[1..label_end];
    if label_text.trim().is_empty() {
        return None;
    }

    let mut cursor = label_end + 2;
    let mut ws = 0;
    while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
        cursor += 1;
        ws += 1;
    }
    if ws == 0 || cursor >= bytes.len() {
        return None;
    }

    let target_col_in_trimmed;
    let target_len;
    let target_text;
    if bytes[cursor] == b'<' {
        let rest = &trimmed[cursor + 1..];
        let close = rest.find('>')?;
        target_col_in_trimmed = cursor + 1;
        target_len = close;
        target_text = &rest[..close];
    } else {
        let rest = &trimmed[cursor..];
        let end = rest
            .find(|c: char| c.is_whitespace())
            .unwrap_or(rest.len());
        if end == 0 {
            return None;
        }
        target_col_in_trimmed = cursor;
        target_len = end;
        target_text = &rest[..end];
    }

    // Validate that anything after the target is either empty or a title
    // opener. A junk trailer probably means this isn't actually a
    // definition (or it's malformed enough that rewriting would be
    // risky).
    let after_start =
        target_col_in_trimmed + target_len + if bytes[cursor] == b'<' { 1 } else { 0 };
    let after = &trimmed[after_start..];
    let after_trimmed = after.trim();
    if !after_trimmed.is_empty() {
        let first = after_trimmed.chars().next()?;
        if !matches!(first, '"' | '\'' | '(') {
            return None;
        }
    }

    Some((label_text, leading + target_col_in_trimmed, target_len, target_text))
}

/// Locate the URL's byte range inside an inline link span of the form
/// `[text](url)` or `[text](<url>)` or `[text](url "title")`. Returns the
/// range in document coordinates (so `span_start + local_offset`).
///
/// `dest_url` is what pulldown-cmark decoded — on our fixtures this is
/// byte-identical to the source, but bracketed forms strip the `<>` so
/// we substring-search for `dest_url` starting *after* the opening `(`.
fn find_inline_url_range(
    span: &str,
    span_start: usize,
    dest_url: &str,
) -> Option<Range<usize>> {
    let open = span.rfind('(')?;
    let slice_after_open = &span[open + 1..];
    let local = slice_after_open.find(dest_url)?;
    let start = span_start + open + 1 + local;
    Some(start..start + dest_url.len())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Byte offsets of each line's first character, in body coordinates.
/// `line_starts[0]` is always 0. The final entry points one past the
/// last byte so `line_starts[i+1] - line_starts[i]` always yields the
/// i-th line's byte length.
fn compute_line_starts(body: &str) -> Vec<usize> {
    let mut starts = Vec::with_capacity(body.len() / 40 + 1);
    starts.push(0);
    for (i, b) in body.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// Convert a byte offset to (line_idx, column_in_bytes). Binary searches
/// the line-start table.
fn offset_to_line_col(line_starts: &[usize], offset: usize) -> (u32, u32) {
    let line_idx = match line_starts.binary_search(&offset) {
        Ok(exact) => exact,
        Err(next) => next.saturating_sub(1),
    };
    let column = offset - line_starts[line_idx];
    (line_idx as u32, column as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::ParsedDocument;
    use serde_json::Map;

    fn doc(body: &str) -> ParsedDocument {
        ParsedDocument {
            frontmatter: Map::new(),
            body: body.to_string(),
        }
    }

    fn relative_targets(edges: &[Edge]) -> Vec<String> {
        edges
            .iter()
            .filter_map(|e| match &e.target {
                LinkTarget::Relative(p) => Some(p.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn extracts_relative_markdown_link() {
        let d = doc("See [intro](intro.md) for context.");
        let edges = extract(&d, Path::new("posts/index.md"));
        let targets = relative_targets(&edges);
        assert!(targets.contains(&"posts/intro.md".to_string()));

        // Inline edge's byte_range should cover just the URL, not the
        // whole `[intro](intro.md)` span.
        let inline = edges
            .iter()
            .find(|e| e.kind == LinkKind::Inline)
            .expect("inline edge");
        assert_eq!(&d.body[inline.byte_range.clone()], "intro.md");
    }

    #[test]
    fn skips_external_links() {
        let d = doc("[google](https://google.com) and [#anchor](#anchor)");
        let edges = extract(&d, Path::new("a.md"));
        assert!(edges.is_empty());
    }

    #[test]
    fn extracts_wiki_link_with_alias() {
        let d = doc("Refer to [[Other Note|alias]] please.");
        let edges = extract(&d, Path::new("a.md"));
        let wiki = edges
            .iter()
            .find(|e| e.kind == LinkKind::Wiki)
            .expect("wiki edge");
        assert_eq!(wiki.target, LinkTarget::Wiki("Other Note".to_string()));
        // Byte range should cover the name portion (before the pipe).
        assert_eq!(&d.body[wiki.byte_range.clone()], "Other Note");
    }

    #[test]
    fn parent_traversal_resolves() {
        let d = doc("[up](../sibling.md)");
        let edges = extract(&d, Path::new("posts/nested/page.md"));
        let targets = relative_targets(&edges);
        assert!(targets.contains(&"posts/sibling.md".to_string()));
    }

    #[test]
    fn extracts_reference_use_and_definition() {
        let body = "\
See [introduction][intro] and the [setup guide][setup].

[intro]: notes/introduction.md
[SETUP]: notes/setup.md \"Setup\"
";
        let d = doc(body);
        let edges = extract(&d, Path::new("index.md"));

        let uses: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == LinkKind::ReferenceUse)
            .collect();
        let defs: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == LinkKind::ReferenceDefinition)
            .collect();

        assert_eq!(uses.len(), 2, "expected two reference uses, got {:?}", uses);
        assert_eq!(defs.len(), 2, "expected two reference defs, got {:?}", defs);

        // Def byte_range should point at just the target.
        assert_eq!(&body[defs[0].byte_range.clone()], "notes/introduction.md");
        assert_eq!(&body[defs[1].byte_range.clone()], "notes/setup.md");

        // Case-insensitive label match: `[setup]` use resolves against
        // `[SETUP]` def → notes/setup.md.
        let setup_use_target = uses
            .iter()
            .find_map(|e| match &e.target {
                LinkTarget::Relative(p) if p == "notes/setup.md" => Some(p.clone()),
                _ => None,
            });
        assert!(
            setup_use_target.is_some(),
            "case-insensitive label resolution failed",
        );
    }

    #[test]
    fn skips_definitions_inside_code_fences() {
        let body = "\
A paragraph.

```
[not-a-def]: should-be-ignored.md
```

[real]: notes/real.md
";
        let d = doc(body);
        let edges = extract(&d, Path::new("a.md"));
        let defs: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == LinkKind::ReferenceDefinition)
            .collect();
        assert_eq!(defs.len(), 1, "expected only the post-fence definition");
        assert_eq!(defs[0].target, LinkTarget::Relative("notes/real.md".to_string()));
    }

    #[test]
    fn skips_definitions_not_at_block_boundary() {
        // A `[label]: target` line that immediately follows prose text is
        // not a CommonMark definition — it's paragraph continuation.
        // Our scanner must agree with pulldown-cmark here or we'd emit a
        // definition edge for text that never resolves anything.
        let body = "\
Prose text that runs into the next line.
[intro]: notes/introduction.md
";
        let d = doc(body);
        let edges = extract(&d, Path::new("a.md"));
        let defs: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == LinkKind::ReferenceDefinition)
            .collect();
        assert!(defs.is_empty(), "definition was emitted despite being inside a paragraph");
    }

    #[test]
    fn angle_bracketed_definition_target() {
        let body = "\
[glossary]: <notes/glossary.md>
";
        let d = doc(body);
        let edges = extract(&d, Path::new("a.md"));
        let def = edges
            .iter()
            .find(|e| e.kind == LinkKind::ReferenceDefinition)
            .expect("definition edge");
        assert_eq!(&body[def.byte_range.clone()], "notes/glossary.md");
    }

    #[test]
    fn line_and_column_are_zero_indexed_bytes() {
        let body = "line0\n  [l2](target.md)\n";
        let d = doc(body);
        let edges = extract(&d, Path::new("a.md"));
        let inline = edges
            .iter()
            .find(|e| e.kind == LinkKind::Inline)
            .expect("inline edge");
        assert_eq!(inline.line, 1);
        // URL starts at column 7: `  [l2](target.md)` → `target.md` begins
        // after `  [l2](` which is 7 bytes.
        assert_eq!(inline.column, 7);
    }

    #[test]
    fn set_links_keeps_backlinks_in_sync() {
        let mut graph = LinkGraph::new();
        let edge_to_b = Edge {
            target: LinkTarget::Relative("b.md".to_string()),
            byte_range: 0..0,
            line: 0,
            column: 0,
            kind: LinkKind::Inline,
        };
        graph.set_links("a.md", vec![edge_to_b]);
        assert!(graph.incoming("b.md").unwrap().contains(&"a.md".to_string()));

        // Replace a.md's edges with an empty list; b.md should lose the
        // back-pointer and the entry should be removed entirely.
        graph.set_links("a.md", vec![]);
        assert!(graph.incoming("b.md").is_none());
    }

    #[test]
    fn forget_drops_all_outgoing_and_incoming() {
        let mut graph = LinkGraph::new();
        let edge_to_b = Edge {
            target: LinkTarget::Relative("b.md".to_string()),
            byte_range: 0..0,
            line: 0,
            column: 0,
            kind: LinkKind::Inline,
        };
        graph.set_links("a.md", vec![edge_to_b]);
        graph.forget("a.md");
        assert!(graph.outgoing("a.md").is_none());
        assert!(graph.incoming("b.md").is_none());
    }
}
