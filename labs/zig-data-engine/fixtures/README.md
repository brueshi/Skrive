# Conformance fixtures

Canonical `.folio` bytes. The round-trip test asserts that parsing and
re-writing any of these reproduces the file **exactly**, which is how the lab
checks that its encoding has not drifted from the app's.

## Why byte-identity and not self-consistency

An encoder that is merely self-consistent round-trips its own output forever
while disagreeing with the app about, say, whether `/` is escaped. Only a
fixture the *app* wrote catches that. `app-written.folio` is such a fixture,
and the rest are held to the same shape.

## Provenance

- **`app-written.folio`** — copied verbatim from the repository's
  `testfolio.folio`, produced by Skrive's own writer. It arrived already
  canonical, which is the cross-check that the rule below describes the real
  output format. It covers headings, paragraphs, tables and footnote
  definitions.
- **Everything else** — hand-authored to cover what `app-written.folio` does
  not (code blocks, rules, blockquotes, both list kinds, task items, every
  inline kind, every mark, links with and without titles, empty containers,
  ragged and empty tables, fractional column widths, preserved `docMeta`
  extras, and the full string-escape range including control characters and
  non-ASCII), then passed through the canonical writer below.

## The canonical form

`JSON.stringify(value, null, 2) + "\n"`, UTF-8, no BOM, with keys in the order
`docs/folio-schema-v1.md` §9 fixes. To re-canonicalize or to check that a
fixture is still canonical, from the lab directory:

```
bun -e 'import{readFileSync,writeFileSync}from"node:fs";
for (const f of process.argv.slice(1))
  writeFileSync(f, JSON.stringify(JSON.parse(readFileSync(f,"utf8")),null,2)+"\n")' fixtures/*.folio
```

This is an authoring-time convenience, not a build dependency: the lab builds
and tests with Zig alone.
