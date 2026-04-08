//! Internal link graph for a Skrive project.
//!
//! For Phase 1.4 the graph is intentionally minimal: forward and inbound link
//! sets keyed by relative path. Phase 3.1 will replace this with a richer model
//! that tracks the position of each link inside its source document so we can
//! support rename-with-references.

use crate::frontmatter::ParsedDocument;
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Forward and back links for the entire project, keyed by project-relative
/// paths in forward-slash form.
#[derive(Debug, Default, Clone)]
pub struct LinkGraph {
    forward: BTreeMap<String, BTreeSet<LinkTarget>>,
    backward: BTreeMap<String, BTreeSet<String>>,
}

/// A single edge target. We track both `[markdown](path.md)` style links and
/// `[[wiki-link]]` style links so we can resolve them differently later.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum LinkTarget {
    Relative(String),
    Wiki(String),
}

impl LinkGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add or replace the outgoing edges for `source`.
    pub fn set_links(&mut self, source: &str, links: BTreeSet<LinkTarget>) {
        // Drop the old back-links from this source before re-indexing.
        if let Some(old) = self.forward.remove(source) {
            for target in old {
                if let LinkTarget::Relative(target_path) = target {
                    if let Some(set) = self.backward.get_mut(&target_path) {
                        set.remove(source);
                    }
                }
            }
        }

        for target in &links {
            if let LinkTarget::Relative(target_path) = target {
                self.backward
                    .entry(target_path.clone())
                    .or_default()
                    .insert(source.to_string());
            }
        }

        self.forward.insert(source.to_string(), links);
    }

    /// Phase 3.1 will expose this through a `get_outgoing_links` command.
    #[allow(dead_code)]
    pub fn outgoing(&self, source: &str) -> Option<&BTreeSet<LinkTarget>> {
        self.forward.get(source)
    }

    /// Phase 3.1 will expose this through a `get_backlinks` command.
    #[allow(dead_code)]
    pub fn incoming(&self, target: &str) -> Option<&BTreeSet<String>> {
        self.backward.get(target)
    }
}

/// Extract internal links from a parsed Markdown document.
///
/// External links (anything starting with a scheme like `http://`, `mailto:`,
/// or a fragment like `#anchor`) are skipped — the link graph only tracks edges
/// inside the project.
///
/// `source_relpath` is the relative path of the document being parsed; relative
/// link targets are resolved against its parent so the resulting `LinkTarget`s
/// are project-relative.
pub fn extract(doc: &ParsedDocument, source_relpath: &Path) -> BTreeSet<LinkTarget> {
    let mut links = BTreeSet::new();
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    let parser = Parser::new_ext(&doc.body, options);

    for event in parser {
        if let Event::Start(Tag::Link { dest_url, .. }) = event {
            if is_external(&dest_url) {
                continue;
            }
            if let Some(rel) = resolve_relative(source_relpath, &dest_url) {
                links.insert(LinkTarget::Relative(rel));
            }
        }
    }

    // pulldown-cmark does not parse `[[wiki-links]]`, so we sweep the body for
    // them ourselves. This is a deliberate Phase 1 hack — Phase 3 will replace
    // it with a proper inline parser extension.
    extract_wiki_links(&doc.body, &mut links);

    links
}

fn is_external(dest: &str) -> bool {
    dest.starts_with('#')
        || dest.starts_with("http://")
        || dest.starts_with("https://")
        || dest.starts_with("mailto:")
        || dest.starts_with("tel:")
}

/// Normalize a relative link target into a project-relative path string with
/// forward slashes. Returns `None` if the link cannot be resolved without
/// escaping the project root.
fn resolve_relative(source_relpath: &Path, dest: &str) -> Option<String> {
    let dest_path = Path::new(dest);
    let mut joined: PathBuf = source_relpath.parent().map(Path::to_path_buf).unwrap_or_default();
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

fn extract_wiki_links(body: &str, links: &mut BTreeSet<LinkTarget>) {
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = find_subsequence(&bytes[i + 2..], b"]]") {
                let inner = &body[i + 2..i + 2 + end];
                let target = inner.split('|').next().unwrap_or(inner).trim();
                if !target.is_empty() {
                    links.insert(LinkTarget::Wiki(target.to_string()));
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
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

    #[test]
    fn extracts_relative_markdown_link() {
        let d = doc("See [intro](intro.md) for context.");
        let links = extract(&d, Path::new("posts/index.md"));
        assert!(links.contains(&LinkTarget::Relative("posts/intro.md".to_string())));
    }

    #[test]
    fn skips_external_links() {
        let d = doc("[google](https://google.com) and [#anchor](#anchor)");
        let links = extract(&d, Path::new("a.md"));
        assert!(links.is_empty());
    }

    #[test]
    fn extracts_wiki_link() {
        let d = doc("Refer to [[Other Note|alias]] please.");
        let links = extract(&d, Path::new("a.md"));
        assert!(links.contains(&LinkTarget::Wiki("Other Note".to_string())));
    }

    #[test]
    fn parent_traversal_resolves() {
        let d = doc("[up](../sibling.md)");
        let links = extract(&d, Path::new("posts/nested/page.md"));
        assert!(links.contains(&LinkTarget::Relative("posts/sibling.md".to_string())));
    }

    #[test]
    fn back_links_track_correctly() {
        let mut graph = LinkGraph::new();
        let mut a_links = BTreeSet::new();
        a_links.insert(LinkTarget::Relative("b.md".to_string()));
        graph.set_links("a.md", a_links);
        assert!(graph
            .incoming("b.md")
            .unwrap()
            .contains(&"a.md".to_string()));
    }
}
