# `.folio` schema — v1

**Status:** Specified (2026-07-02). This is the field-level spec for SKR-195 stage 1
(the schema half; I/O implementation follows in Wave B). It is also the **public
portability spec** — the "documented schema" the trust contract promises, so a
`.folio` can always be read and converted by anything, not just Skrive.

`.folio` is Skrive's **native rich-document format**: one file per document, holding
the full block model with marks and attributes and **no reduction to Markdown**.
It is what removes the byte-round-trip contract for rich content (the source of the
SKR-153 audit's fidelity bug class). Markdown, HTML, TXT and RTF become
**import/export**, not the store.

---

## 1. File envelope

A `.folio` v1 file is a single UTF-8 JSON object (no BOM, LF line endings, trailing
newline):

```json
{
  "schemaVersion": 1,
  "docId": "01j9z8n2q4r7v0c3m6k8t1x5ab",
  "docMeta": { "title": "Untitled", "createdAt": "2026-07-02T18:00:00.000Z" },
  "blocks": []
}
```

Top-level keys, in this fixed order: `schemaVersion`, `docId`, `docMeta`, `blocks`.

- **`schemaVersion`** (integer) — `1`. Bumped only on a breaking container/shape
  change; the zip form for embedded media is the reserved **v2** (see §8).
- **`docId`** (string) — stable document identity (§3).
- **`docMeta`** (object) — document-level metadata (§4).
- **`blocks`** (array) — the canonical block tree in document order (§5–§6).

### Version detection (readers must)

Detect the form by the **first non-whitespace byte**: `{` → JSON v1; `PK` (0x50
0x4B) → a v2 zip container. A v1-only reader that sees a `schemaVersion` it does
not understand, or a zip magic it cannot open, **refuses forward gracefully** with
a clear message — it never partially parses or silently drops content.

---

## 2. Relationship to the block model (what carries, what is dropped)

`.folio` mirrors the block model (`app/src/lib/blockmodel/types.ts`) **minus every
Markdown-serialization-fidelity field**, because those exist only to hold Markdown
bytes byte-faithful — exactly the contract `.folio` abolishes:

| Model field | In `.folio`? | Why |
|---|---|---|
| `id` | **kept** (persisted for every block) | Native store persists block identity directly (not via `<!-- sk:ID -->` anchors); the engine keys per-block on it (§7). |
| `type`, semantic content (`inline`, `level`, `text`, `children`, `items`, `rows`, `align`, `checked`, `start`) | **kept** | The actual document. |
| `src`, `gapBefore`, `dirty` | **dropped** | Verbatim-Markdown-bytes bookkeeping; meaningless without a Markdown store. |
| `durable` | **dropped** | Every block's id is persisted here; there is no "only anchor-bearing blocks persist" split. |
| `code_block.fence` | **dropped** | A Markdown fence-style artifact (` ``` ` vs `~~~`); native code has no fence. `lang`/`meta` are kept as real attributes. |
| `bullet_list.marker`, `ordered_list.delimiter` | **dropped** | Markdown syntax (`-`/`*`/`+`, `.`/`)`); presentation, not content. `ordered_list.start` and list `spread` are kept (real rendering distinctions). |
| `frozen_block` | **not present** | It is the escape hatch for constructs Markdown can't model; the native format models everything, so nothing is ever frozen. On import, a frozen block resolves to its real block type or to a paragraph. |

**Block ids.** Reuse the existing generator grammar: opaque, lowercase base36,
`^[0-9a-z]+$`, unique **within a document**. Ids are stable across edits and
travel with their block (edit keeps it; split mints a fresh one for the new block;
merge keeps the survivor's; reorder carries it). They are **persisted for every
block** in `.folio` (unlike `.md`, where only durable blocks anchor their id).

---

## 3. `docId` — document identity

Every `.folio` carries a stable identity **minted once at creation** and **distinct
from its path**. All managed truth (backlinks, per-block history, sidebar
structure, collections) keys on `docId`, never on path — a rename or move *outside*
Skrive re-binds by reading the id back from the file. This is the deliberate
alternative to storing documents *inside* the engine: the engine is
catalog / index / history, **never custodian** (data-engine plan §0.6).

### Format

`docId` is a **ULID** — 128 bits = a 48-bit millisecond timestamp + 80 bits of
CSPRNG randomness, Crockford base32, **lowercased**, 26 chars, no hyphens:

```
01j9z8n2q4r7v0c3m6k8t1x5ab
```

Chosen over UUIDv4/v7 for being lexicographically **creation-time-sortable** (a
free ordering key for the engine's catalog) while staying filename- and
JSON-clean. A UUIDv7 is an acceptable equivalent if a ULID dependency is
unwanted; the only hard requirements are global uniqueness, opacity, and
stability. It is **not** derived from the filename or content, so a rename never
changes it.

### Mint & collision policy (the Finder-duplicate case)

- **Mint** at document creation (new `.folio`, or on `.md → .folio` upgrade).
- Duplicating a file **outside Skrive** (Finder ⌘D, `cp`) produces two files with
  the **same** `docId`. On the **first open of a file whose `docId` is already
  bound to a different existing path**, the copy is **re-minted** a fresh `docId`
  and rewritten. This is the SKR-163 duplicate-anchor lesson applied to documents:
  identity must be one-to-one with a document, not a byte pattern.
- **Detection** is the **catalog's** job (docId → path map): re-mint fires only
  when the catalog is present and reports a conflict. **Before the engine exists**,
  `.folio` ships with plain file I/O and no collision detection — a duplicated
  file harmlessly shares an id, because nothing yet keys on `docId`; the first
  index pass after the engine lands reconciles it. The file format needs no change
  for this — re-mint is a rewrite of the `docId` field.

---

## 4. `docMeta`

Document-level metadata. Minimal and **extensible** — a reader **preserves unknown
keys** verbatim across a load/save so a newer writer's additions survive a
round-trip through an older reader.

```json
{ "title": "My document", "createdAt": "2026-07-02T18:00:00.000Z" }
```

- **`title`** (string | null) — the document title. `null` (or absent) means
  "derive from the first heading."
- **`createdAt`** (string) — ISO-8601 UTC, set **once at mint**, immutable.

**No `updatedAt` in the file body** — deliberately. A modified-time that changed on
every save would break the byte-determinism guarantee (§6): an unchanged document
must produce a byte-identical file. Last-modified is the filesystem's mtime and
the engine's catalog to track, not the document's bytes.

---

## 5. Blocks

`blocks` is the document's top-level blocks in order. Containers nest their block
children, so the array is a **tree**. Every block object begins with `id` then
`type`; type-specific fields follow in the order given below.

### Leaf blocks

```json
{ "id": "a1b2c3d4e5", "type": "paragraph", "inline": [ … ] }
{ "id": "…", "type": "heading", "level": 2, "inline": [ … ] }
{ "id": "…", "type": "code_block", "lang": "ts", "meta": null, "text": "const x = 1\n" }
{ "id": "…", "type": "horizontal_rule" }
```

- **`heading.level`** — integer 1–6.
- **`code_block`** — `lang` (string, `""` when none), `meta` (string | null),
  `text` (verbatim, newlines as `\n`).

### Container blocks

```json
{ "id": "…", "type": "blockquote", "children": [ … ] }

{ "id": "…", "type": "bullet_list", "spread": false, "items": [
  { "spread": false, "children": [ … ] },
  { "spread": false, "checked": true, "children": [ … ] }
] }

{ "id": "…", "type": "ordered_list", "start": 1, "spread": false, "items": [ … ] }

{ "id": "…", "type": "footnote_definition", "label": "1", "children": [ … ] }
```

- **List `spread`** (boolean) — loose (blank-line-separated, paragraph-rendered)
  vs tight. On the list, and per-item for the item's own child rhythm.
- **`ListItem`** — `{ spread, checked?, children }`. `checked` (boolean) is present
  only for task-list items (`true`/`false`); absent for a plain item. `children`
  is a block array (list items hold blocks, enabling nesting).
- **`footnote_definition`** — `{ id, type, label, children }`. The body of the
  footnote `label` names (a `footnote_ref` leaf, §6, points here). The block keeps
  its **authored position** in the block list; gathering definitions into a
  document-end footer is the renderer's job, not the store's — so the position
  round-trips.

### Table

```json
{ "id": "…", "type": "table", "align": ["left", null, "right"],
  "widths": [0.3333, 0.25, 0.4167], "rows": [
  [ [ … ], [ … ], [ … ] ],
  [ [ … ], [ … ], [ … ] ]
] }
```

- **`align`** — array length = column count; each `"left" | "right" | "center" |
  null`, from the header.
- **`widths`** (optional) — per-column relative width weights, array length =
  column count. Present only when the table has custom column widths; absent
  entirely otherwise. Values are fractions that sum to approximately 1,
  rounded to four decimal places. `.folio`-only: GFM has no width syntax, so
  Markdown export drops them.
- **`rows`** — row 0 is the header; the rest are body rows. Each **cell is an
  inline array** (§6). Ragged rows are permitted natively (a row may have fewer or
  more cells than the header) — the native format has no column-clamp, which is
  the fix for the audit's ragged-table data loss (SKR-159); export to Markdown is
  where clamping/padding happens, not the store.

---

## 6. Inline content and marks

An `inline` array (and each table cell) is a list of inline leaves:

```json
{ "kind": "text",  "text": "hello", "marks": { "strong": true } }
{ "kind": "image", "url": "assets/diagram.png", "alt": "…", "title": null, "marks": {} }
{ "kind": "break", "marks": {} }
{ "kind": "tag", "name": "project/skrive", "marks": {} }
{ "kind": "footnote_ref", "label": "1", "marks": {} }
```

- **`text`** — `{ kind, text, marks }`.
- **`image`** — `{ kind, url, alt, title, marks }`. `url` is a **reference**
  (relative asset path or asset id), never an embedded blob (§8). Inline images are
  atoms; they occupy one unit of offset space in the editor (SKR-155).
- **`break`** — `{ kind, marks }`, a hard line break within a block.
- **`tag`** — `{ kind, name, marks }`, an inline tag (`#name`, nested
  `#parent/child`); `name` is the text after the `#`. Native here — in `.md` a tag
  is literal body text.
- **`footnote_ref`** — `{ kind, label, marks }`, a footnote reference
  (`[^label]`); `label` points at the `footnote_definition` block (§5) carrying
  the content. A single-cell atom, like an image.

### `marks`

An object carrying **only the marks that are set** (for determinism and
compactness — never `"em": false`):

```json
{ "em": true, "strong": true, "code": true, "strikethrough": true,
  "underline": true, "link": { "href": "https://…", "title": null } }
```

Boolean marks: `em`, `strong`, `code`, `strikethrough`, `underline`. `link` is
`{ href, title }` (`title` string | null). A leaf with no marks has `"marks": {}`.

---

## 7. One encoding, three consumers

The block encoding above is the single schema shared by (data-engine plan §0.3):

1. the **file body** (`blocks`),
2. the engine's write-ahead-log `PutBlock` **payload**, and
3. the **Zig ↔ JS boundary** contract.

The requirement this imposes: **every block is individually encodable** — a block
object is self-contained and valid on its own, so a single block (with its subtree,
for a container) can be a log record or cross the boundary without the enclosing
document. The schema honors this: no block references another by position or by a
shared table; identity is the intrinsic `id`; a container carries its children
inline. Per-block history therefore logs a block subtree keyed by `id`.

The engine consumes this encoding and is **catalog, index, history and
durability accelerator — never custodian** (§0.6): the words always live in the
files, and losing the engine never costs content. It does not follow that the
engine holds nothing of its own. Per-block history is store-only and **no file
scan reconstructs it**, because a file holds a document's present and not its
past. Re-scanning the `.folio` files rebuilds every *derived* fact — the search
index, backlinks, the path/identity map — and restores identity, since each
file carries its own `docId` and block ids. What it cannot restore is history.
This is the data-engine plan §2.1 asymmetry: store loss costs history, never
words.

---

## 8. Media (v1 text-only) and the v2 container

- **v1 is text-only with assets by reference.** No base64, no embedded binaries in
  the JSON. An inline image's `url` points at an asset the app resolves; the model
  never holds blob bytes.
- **v2 (reserved)** is the container form for embedded media (SKR-129): a **zip**
  whose first entry is the same JSON document and whose blob entries are
  memory-mapped / streamed on demand, **never loaded into the model**. It bumps
  `schemaVersion` and is detected by the `PK` magic (§1). v1 readers refuse it
  forward gracefully.

---

## 9. Determinism

Unchanged content **must** serialize to a byte-identical file (clean diffs under
git and backup tools; a no-op save rewrites nothing). The writer guarantees:

- **Fixed key order** everywhere: envelope (`schemaVersion`, `docId`, `docMeta`,
  `blocks`); block (`id`, `type`, then the type-specific order in §5); inline
  (`kind`, then fields, `marks` last); marks (`em`, `strong`, `code`,
  `strikethrough`, `underline`, `link`); link (`href`, `title`); docMeta (`title`, `createdAt`,
  then preserved unknown keys in first-seen order).
- **Only set marks emitted**; absent booleans omitted.
- **Pretty-printed**, 2-space indent, LF, single trailing newline, UTF-8 no BOM, no
  trailing whitespace.
- **Arrays in document order**; no incidental reordering.
- **Numbers** as minimal decimal integers where the field is an integer
  (`schemaVersion`, `heading.level`, `ordered_list.start`). `table.widths` is
  the one float-valued field (§5); its values are written exactly as the
  writer produced them, and a reader **must round-trip a number's source token
  verbatim** rather than re-deriving it from a parsed float, or byte-identity
  is lost the moment two implementations format a decimal differently.

Preserved unknown keys (§4) sort deterministically (append in first-seen order,
retained across the round trip) so forward-compatible additions stay diff-stable.

---

## 10. Example fixtures

### Minimal (empty document)

```json
{
  "schemaVersion": 1,
  "docId": "01j9z8n2q4r7v0c3m6k8t1x5ab",
  "docMeta": { "title": null, "createdAt": "2026-07-02T18:00:00.000Z" },
  "blocks": []
}
```

### Rich (every construct)

```json
{
  "schemaVersion": 1,
  "docId": "01j9zc4t8b2n5q0w7e3r6y9u1d",
  "docMeta": { "title": "Kitchen sink", "createdAt": "2026-07-02T18:05:00.000Z" },
  "blocks": [
    { "id": "h1a2b3c4d5", "type": "heading", "level": 1,
      "inline": [ { "kind": "text", "text": "Title", "marks": {} } ] },
    { "id": "p1a2b3c4d5", "type": "paragraph",
      "inline": [
        { "kind": "text", "text": "A ", "marks": {} },
        { "kind": "text", "text": "bold", "marks": { "strong": true } },
        { "kind": "text", "text": " and ", "marks": {} },
        { "kind": "text", "text": "linked", "marks": { "link": { "href": "https://skrive.md", "title": null } } },
        { "kind": "text", "text": " line.", "marks": {} },
        { "kind": "break", "marks": {} },
        { "kind": "text", "text": "Second visual line.", "marks": {} }
      ] },
    { "id": "c1a2b3c4d5", "type": "code_block", "lang": "ts", "meta": null,
      "text": "const x = 1\nconst y = 2\n" },
    { "id": "b1a2b3c4d5", "type": "bullet_list", "spread": false, "items": [
      { "spread": false, "checked": true,
        "children": [ { "id": "p2a2b3c4d5", "type": "paragraph",
          "inline": [ { "kind": "text", "text": "done", "marks": {} } ] } ] },
      { "spread": false, "checked": false,
        "children": [ { "id": "p3a2b3c4d5", "type": "paragraph",
          "inline": [ { "kind": "text", "text": "todo", "marks": {} } ] } ] }
    ] },
    { "id": "t1a2b3c4d5", "type": "table", "align": ["left", "right"], "rows": [
      [ [ { "kind": "text", "text": "A", "marks": { "strong": true } } ],
        [ { "kind": "text", "text": "B", "marks": { "strong": true } } ] ],
      [ [ { "kind": "text", "text": "1", "marks": {} } ],
        [ { "kind": "text", "text": "2", "marks": {} } ] ]
    ] },
    { "id": "r1a2b3c4d5", "type": "horizontal_rule" },
    { "id": "q1a2b3c4d5", "type": "blockquote", "children": [
      { "id": "p4a2b3c4d5", "type": "paragraph",
        "inline": [ { "kind": "text", "text": "quoted", "marks": { "em": true } } ] }
    ] }
  ]
}
```

---

## 11. Open items (for the I/O half — Wave B)

- **Atomic writes** — temp + fsync + rename, mirroring the current `.md` save path.
- **Canonical writer/reader** — a deterministic serializer (§9) and a tolerant
  parser (preserves unknown keys, refuses forward on version mismatch).
- **`.md → .folio` upgrade** — the explicit, visible action that mints a `docId`
  and produces a new file; it must never silently enrich a `.md` in place.
- **ULID/UUIDv7 dependency call** — pick the generator; keep it injectable for
  deterministic tests (as the block-id generator already is).
