//! `.skrive.toml` parser.
//!
//! The file is per-project configuration — severity of lint rules, the
//! project dictionary, checkpoint retention caps, forward-looking
//! export settings. The schema is documented in
//! [`docs/skrive-toml-reference.md`](../../docs/skrive-toml-reference.md);
//! treat that file as the source of truth for field names, defaults,
//! and meaning. This module is the typed reader.
//!
//! Parse behavior follows the schema doc's promise:
//!   - Missing `.skrive.toml` is not an error; defaults apply.
//!   - Malformed `.skrive.toml` logs a warning and falls back to
//!     defaults. Never blocks project open.
//!   - Unknown sections and unknown keys inside known sections are
//!     ignored — old Skrive builds keep working when newer Skrive
//!     adds a field, and new Skrive builds keep working with older
//!     `.skrive.toml` files.
//!
//! Live reload on file change is not wired up yet; see the pending
//! "live reload via watcher" task. Users close + reopen the project
//! to pick up config edits.

use serde::Deserialize;
use std::path::Path;

/// Top-level config. Every field is optional in the TOML; a fully
/// default `SkriveConfig` is what you get when `.skrive.toml` doesn't
/// exist. Consumers read field-by-field rather than taking the
/// whole struct so unrelated subsystems don't couple to each other.
///
/// Forward-looking sections (`[export.*]`) are accepted by the
/// parser — they don't trip the "unknown field" path — but we don't
/// descend into their schemas here. The concrete exporters will own
/// their own typed sub-structs when Phase 5 ships.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SkriveConfig {
    pub project: ProjectConfig,
    pub lint: LintConfig,
    pub dictionary: DictionaryConfig,
    pub checkpoints: CheckpointsConfig,
}

impl Default for SkriveConfig {
    fn default() -> Self {
        Self {
            project: ProjectConfig::default(),
            lint: LintConfig::default(),
            dictionary: DictionaryConfig::default(),
            checkpoints: CheckpointsConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    /// Overrides the directory name in the header and recents list.
    /// `None` means "use the basename of the project path."
    pub name: Option<String>,
}

/// Severity configuration for the Phase 3.4 structural-lint engine.
/// Per-field defaults differ from the enum's own `Default::default()`
/// (which is `Off`), so the fields use explicit `#[serde(default =
/// "...")]` functions. Rule added in a future version without updating
/// this struct falls through serde's unknown-field tolerance and is
/// silently ignored — matching the schema doc's forward-compat rule.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
// The per-rule severity fields are consumed by the Phase 3.4 lint
// engine, not by any shipped subsystem today. Parsing them now means
// users can populate `.skrive.toml` against the committed schema.
#[allow(dead_code)]
pub struct LintConfig {
    #[serde(default = "default_broken_internal_links")]
    pub broken_internal_links: LintSeverity,
    #[serde(default = "default_missing_required_frontmatter")]
    pub missing_required_frontmatter: LintSeverity,
    #[serde(default = "default_heading_hierarchy")]
    pub heading_hierarchy: LintSeverity,
    #[serde(default = "default_orphaned_files")]
    pub orphaned_files: LintSeverity,
    #[serde(default = "default_duplicate_headings")]
    pub duplicate_headings: LintSeverity,
    pub required_frontmatter: RequiredFrontmatterConfig,
}

impl Default for LintConfig {
    fn default() -> Self {
        Self {
            broken_internal_links: default_broken_internal_links(),
            missing_required_frontmatter: default_missing_required_frontmatter(),
            heading_hierarchy: default_heading_hierarchy(),
            orphaned_files: default_orphaned_files(),
            duplicate_headings: default_duplicate_headings(),
            required_frontmatter: RequiredFrontmatterConfig::default(),
        }
    }
}

fn default_broken_internal_links() -> LintSeverity {
    LintSeverity::Error
}
fn default_missing_required_frontmatter() -> LintSeverity {
    LintSeverity::Warn
}
fn default_heading_hierarchy() -> LintSeverity {
    LintSeverity::Warn
}
fn default_orphaned_files() -> LintSeverity {
    LintSeverity::Off
}
fn default_duplicate_headings() -> LintSeverity {
    LintSeverity::Warn
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LintSeverity {
    Error,
    Warn,
    #[default]
    Off,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RequiredFrontmatterConfig {
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DictionaryConfig {
    pub project_words: Vec<String>,
}

/// Retention caps for the Skrive-managed checkpoint store (non-git
/// projects only; git-mode projects ignore this section). `auto_cap`
/// is the number of most-recent auto checkpoints kept per file;
/// older autos prune after each write. `manual_cap` is the same for
/// manual "pinned" checkpoints, with `0` meaning unbounded — the
/// schema doc's default, and the shape the checkpoint writer
/// originally shipped with.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CheckpointsConfig {
    #[serde(default = "default_auto_cap")]
    pub auto_cap: usize,
    #[serde(default)]
    pub manual_cap: usize,
}

impl Default for CheckpointsConfig {
    fn default() -> Self {
        Self {
            auto_cap: default_auto_cap(),
            manual_cap: 0,
        }
    }
}

fn default_auto_cap() -> usize {
    50
}

impl SkriveConfig {
    /// Load `.skrive.toml` from the project root. Missing file,
    /// unreadable file, and malformed file all return
    /// `Self::default()` with a warning logged — never panics, never
    /// bubbles the error up. The caller uses whatever we return;
    /// config is best-effort, not a gate.
    pub fn load(project_root: &Path) -> Self {
        let path = project_root.join(".skrive.toml");
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Self::default();
            }
            Err(e) => {
                eprintln!(
                    "skrive: .skrive.toml read failed for {}: {} — using defaults",
                    path.display(),
                    e,
                );
                return Self::default();
            }
        };
        Self::from_toml(&text)
    }

    /// Parse `.skrive.toml` content directly. Factored out of `load`
    /// so tests can exercise every serde branch without touching the
    /// filesystem.
    pub fn from_toml(text: &str) -> Self {
        match toml::from_str::<Self>(text) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!(
                    "skrive: .skrive.toml parse error, using defaults: {}",
                    e,
                );
                Self::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_returns_all_defaults() {
        let cfg = SkriveConfig::from_toml("");
        assert_eq!(cfg.checkpoints.auto_cap, 50);
        assert_eq!(cfg.checkpoints.manual_cap, 0);
        assert_eq!(cfg.lint.broken_internal_links, LintSeverity::Error);
        assert_eq!(cfg.lint.duplicate_headings, LintSeverity::Warn);
        assert_eq!(cfg.lint.orphaned_files, LintSeverity::Off);
        assert!(cfg.project.name.is_none());
        assert!(cfg.dictionary.project_words.is_empty());
        assert!(cfg.lint.required_frontmatter.fields.is_empty());
    }

    #[test]
    fn checkpoints_section_overrides_caps() {
        let cfg = SkriveConfig::from_toml(
            "[checkpoints]\nauto_cap = 10\nmanual_cap = 5\n",
        );
        assert_eq!(cfg.checkpoints.auto_cap, 10);
        assert_eq!(cfg.checkpoints.manual_cap, 5);
    }

    #[test]
    fn checkpoints_partial_keeps_other_defaults() {
        // Only `auto_cap` is set — `manual_cap` falls back to the
        // field-level default (0 = unbounded), not left unset.
        let cfg = SkriveConfig::from_toml("[checkpoints]\nauto_cap = 25\n");
        assert_eq!(cfg.checkpoints.auto_cap, 25);
        assert_eq!(cfg.checkpoints.manual_cap, 0);
    }

    #[test]
    fn lint_partial_section_preserves_per_rule_defaults() {
        // A user who only wants to override one rule shouldn't silently
        // flip every other rule to the enum's default (Off). Per-field
        // `#[serde(default = "...")]` restores the spec's per-rule
        // defaults.
        let cfg = SkriveConfig::from_toml(
            "[lint]\nbroken_internal_links = \"warn\"\n",
        );
        assert_eq!(cfg.lint.broken_internal_links, LintSeverity::Warn);
        assert_eq!(cfg.lint.missing_required_frontmatter, LintSeverity::Warn);
        assert_eq!(cfg.lint.heading_hierarchy, LintSeverity::Warn);
        assert_eq!(cfg.lint.orphaned_files, LintSeverity::Off);
        assert_eq!(cfg.lint.duplicate_headings, LintSeverity::Warn);
    }

    #[test]
    fn required_frontmatter_fields_parse() {
        let cfg = SkriveConfig::from_toml(
            "[lint.required_frontmatter]\nfields = [\"title\", \"date\"]\n",
        );
        assert_eq!(
            cfg.lint.required_frontmatter.fields,
            vec!["title".to_string(), "date".to_string()],
        );
    }

    #[test]
    fn dictionary_project_words_parse() {
        let cfg = SkriveConfig::from_toml(
            "[dictionary]\nproject_words = [\"Skrive\", \"Bruechner\"]\n",
        );
        assert_eq!(cfg.dictionary.project_words, vec!["Skrive", "Bruechner"]);
    }

    #[test]
    fn project_name_overrides_default() {
        let cfg = SkriveConfig::from_toml("[project]\nname = \"Field Notes\"\n");
        assert_eq!(cfg.project.name.as_deref(), Some("Field Notes"));
    }

    #[test]
    fn malformed_toml_degrades_to_defaults() {
        // Unclosed quote, unbalanced bracket, whatever — the parser
        // logs and falls back. Project open must not fail.
        let cfg = SkriveConfig::from_toml("[unclosed section\nauto_cap = ?\n");
        assert_eq!(cfg.checkpoints.auto_cap, 50);
    }

    #[test]
    fn unknown_top_level_section_is_ignored() {
        // Forward compat: a future Skrive that adds a new section
        // shouldn't break this build. Serde default behavior is
        // lenient (no `deny_unknown_fields` attribute), so an
        // unrecognized `[future.thing]` just doesn't populate anything
        // — the known sections still parse.
        let cfg = SkriveConfig::from_toml(
            "[future]\nfuture_key = 1\n[checkpoints]\nauto_cap = 7\n",
        );
        assert_eq!(cfg.checkpoints.auto_cap, 7);
    }

    #[test]
    fn unknown_key_in_known_section_is_ignored() {
        let cfg = SkriveConfig::from_toml(
            "[checkpoints]\nauto_cap = 13\nfuture_knob = true\n",
        );
        assert_eq!(cfg.checkpoints.auto_cap, 13);
        assert_eq!(cfg.checkpoints.manual_cap, 0);
    }

    #[test]
    fn export_section_parses_without_descending() {
        // [export.*] isn't claimed by this module — Phase 5 will own
        // its schema. We just want to confirm the parser accepts the
        // section without error so users can populate it today for a
        // future build.
        let toml = r#"
[export.astro]
target_dir = "../site/content"

[export.custom.my_target]
template_dir = "./templates"
"#;
        let cfg = SkriveConfig::from_toml(toml);
        // The known sections keep their defaults.
        assert_eq!(cfg.checkpoints.auto_cap, 50);
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = SkriveConfig::load(dir.path());
        assert_eq!(cfg.checkpoints.auto_cap, 50);
    }

    #[test]
    fn load_reads_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".skrive.toml"),
            "[project]\nname = \"Temp\"\n[checkpoints]\nauto_cap = 3\n",
        )
        .unwrap();
        let cfg = SkriveConfig::load(dir.path());
        assert_eq!(cfg.project.name.as_deref(), Some("Temp"));
        assert_eq!(cfg.checkpoints.auto_cap, 3);
    }
}
