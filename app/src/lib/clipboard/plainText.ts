// Plain-text paste segmentation (SKR-148). Interpreted paste gives markup-free
// text CommonMark paragraph semantics: a blank line separates paragraphs, a
// single newline is a soft break that flows as a space. Line edges shed their
// whitespace — hard-wrapped sources (terminals, emails, PDFs) indent
// continuation lines incidentally, not meaningfully.
export function plainTextParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((segment) =>
      segment
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' ')
    )
    .filter((segment) => segment.length > 0);
}

// Literal paste segmentation (⌘⇧V, SKR-185 / F28). The escape hatch from Markdown
// interpretation must also be an escape hatch from REFLOW: what you copied is what
// lands. So, unlike the flow path above, nothing is trimmed and no line is dropped.
//
// Semantics, chosen now that SKR-176 made hard breaks a real gesture:
//   - a blank line is a paragraph seam    -> one segment per paragraph
//   - a single newline is a hard break    -> survives INSIDE a segment
//
// The alternative — one paragraph per line — cannot tell `a\nb` from `a\n\nb`, so
// it loses structure the writer can see on screen. Two limits are inherent rather
// than chosen: a run of three or more blank lines collapses to one seam (an empty
// paragraph has no Markdown form), and `\r` alone is a newline, not a character to
// delete, which is what the old path did to classic-Mac and some terminal sources.
//
// One trailing newline is dropped. Copying a whole line in VS Code or a terminal
// carries its terminator along, and honoring it would append a stray empty line to
// every such paste. Nothing else about the text is touched.
export function literalParagraphs(raw: string): string[] {
  return raw.replace(/\r\n?/g, '\n').replace(/\n$/, '').split(/\n{2,}/);
}
