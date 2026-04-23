# `.skrive.toml` Reference

`.skrive.toml` is the per-project configuration file for Skrive. It lives in the project root — the same directory that holds your Markdown — and is meant to be committed to git so everyone on the project sees the same lint rules, dictionary, and export targets.

The file is entirely optional. A project with no `.skrive.toml` works fine; Skrive applies sensible defaults. Every section below is optional too. Drop in just the bits you need.

## Where it goes

```
my-project/
├── .skrive.toml          ← here
├── README.md
├── notes/
│   └── ...
└── ...
```

Skrive reads `.skrive.toml` when a project opens. Live reload on file change is a tracked follow-up — until it ships, reopen the project (close + open) to apply edits.

## Parse behavior

If `.skrive.toml` has a syntax error or an unrecognized field, Skrive shows a toast with the problem and falls back to defaults for whatever couldn't be parsed. The project still opens. Unknown top-level sections and unknown keys inside known sections are ignored with a warning — that keeps old Skrive builds working when a newer version adds a field.

Never blocks project open. The writer-side cost of a silent config error is lower than the cost of being locked out of your own notes.

## `[project]`

Project-level metadata. Currently only `name` is read; everything else is forward-looking.

```toml
[project]
name = "My Writing Project"
```

| Key    | Type   | Default                       | Notes                                                                                   |
| ------ | ------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| `name` | string | basename of the project path  | Displayed in the header and the recent-projects list. Overrides the directory name. |

## `[lint]`

Severity configuration for the structural lint engine. Each rule takes one of three values:

- `"error"` — shown with an error-weight gutter marker and counted in the lint panel's error total.
- `"warn"` — shown with a warning-weight gutter marker.
- `"off"` — rule disabled entirely; no marker, no panel entry.

```toml
[lint]
broken_internal_links       = "error"
missing_required_frontmatter = "warn"
heading_hierarchy            = "warn"
orphaned_files               = "off"
duplicate_headings           = "warn"
```

| Rule                           | Default | What it catches                                                                    |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| `broken_internal_links`        | `error` | Links to files that don't exist, or references with no matching `[label]:` definition. |
| `missing_required_frontmatter` | `warn`  | Files that don't declare every field listed in `[lint.required_frontmatter].fields`. Silently off if that list is empty. |
| `heading_hierarchy`            | `warn`  | Skipped heading levels — e.g. an `h3` directly under an `h1` with no `h2` between. |
| `orphaned_files`               | `off`   | Markdown files with zero inbound links from anywhere else in the project.          |
| `duplicate_headings`           | `warn`  | Two headings with identical text at the same level inside one file.                |

### `[lint.required_frontmatter]`

The list of frontmatter fields every Markdown file in the project should declare. Consumed by the `missing_required_frontmatter` rule.

```toml
[lint.required_frontmatter]
fields = ["title", "date", "tags"]
```

Missing-field warnings surface in two places: as a gutter marker on the file's opening frontmatter fence (or line 1 if there's no frontmatter), and as an indicator in the frontmatter panel listing exactly which fields are missing. The panel is where you fix them, the gutter is where you notice.

## `[dictionary]`

Project-scoped spellcheck words. Additive on top of the personal dictionary — a word passes spellcheck if either list contains it. The personal dictionary (edited via the spellcheck panel, stored per-user in app state) is never replaced or overridden.

```toml
[dictionary]
project_words = [
  "Skrive",
  "atticus",
  "Bruechner",
]
```

| Key             | Type     | Default | Notes                                               |
| --------------- | -------- | ------- | --------------------------------------------------- |
| `project_words` | string[] | `[]`    | Case-insensitive match. Whitespace-trimmed on load. |

Use this for project-specific proper nouns, jargon, and names that every collaborator should recognize. Use the personal dictionary for your own one-off words.

## `[export.*]`

Export target configuration — consumed by Phase 5 exporters. Included in the schema now so the shape is settled before the exporters ship; none of these keys do anything in Pre-Alpha.

Each concrete exporter gets its own subsection. The known ones:

```toml
[export.astro]
target_dir = "../my-astro-site/src/content"
frontmatter_map = { date = "pubDate", tags = "categories" }

[export.docusaurus]
target_dir = "../docs-site/docs"

[export.nextjs_mdx]
target_dir = "../web/content"

[export.obsidian]
vault_dir = "~/Documents/Obsidian/MyVault"

[export.custom.my_renderer]
template_dir = "./templates"
output_dir   = "./dist"
```

The `[export.custom.*]` namespace is for user-defined render targets. Each subtable is named by the user (`my_renderer` above) and points at a template directory. Schema for `[export.custom.*]` locks in with Phase 5.2e.

## `[checkpoints]`

Tunes the lightweight version-history store Skrive writes when a project isn't a git repo. Shape is documented in [`docs/checkpoint-storage.md`](checkpoint-storage.md); the parser consumes these keys on `open_project`. Edit and reopen the project to apply changes (live reload via the watcher is a tracked follow-up).

```toml
[checkpoints]
auto_cap   = 50         # max auto checkpoints kept per file; oldest pruned first
manual_cap = 0          # 0 = unbounded; manually-pinned checkpoints are never auto-pruned
```

Git-mode projects (anything with a `.git/` ancestor) ignore this section — git is their history source.

## Versioning

No explicit version field. The schema is additive — new keys and sections may appear in future Skrive versions, but existing keys keep their meaning. Unknown keys are ignored with a warning, so older files keep working with newer Skrive and vice versa.

## Complete example

```toml
[project]
name = "Field Notes"

[lint]
broken_internal_links       = "error"
missing_required_frontmatter = "warn"
heading_hierarchy            = "warn"
orphaned_files               = "warn"
duplicate_headings           = "off"

[lint.required_frontmatter]
fields = ["title", "date"]

[dictionary]
project_words = ["Skrive", "frontmatter", "pulldown"]
```

## Related

- [Open question A4](../planning/open-questions.md) — the design conversation that settled this schema.
- `phase-3.4-plan.md` — the lint engine that will be the first real consumer of `[lint]`.
- Phase 5.2 (outline) — the exporters that will consume `[export.*]`.
