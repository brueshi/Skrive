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
