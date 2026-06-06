// Formatting glyphs for the Rich affordances (toolbar, selection bubble, slash
// menu). 24x24 grid, currentColor, ~1.6 stroke — the house style.
//
// The eight formatting marks — bold, italic, code, quote, bullet list, ordered
// list, divider, table — are the finished paper.design drawings (Plate 08,
// "Markup."): hand-drawn paths, no font-dependent <text>. The remaining glyphs
// here (link, code block, heading, paragraph, chevron) are still interim house-
// style placeholders. The eventual home for the finished marks is one file each
// under components/icons/; until that promotion they live together here.

type IconProps = { size?: number; className?: string };

function Glyph({
  size = 16,
  className = '',
  fill = 'none',
  children
}: IconProps & { fill?: string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconBold(p: IconProps) {
  // A solid "B" — emphasis is weight, so the mark is drawn as ink rather than
  // line. Stem and two bowls as a single filled path; the counters are evenodd
  // holes. (paper.design Plate 08, No. 25.)
  return (
    <Glyph {...p} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M6 4H13C16 4 17 5.4 17 7.6C17 9.2 16.2 10.4 14.8 10.9C16.6 11.3 18 12.6 18 15C18 17.8 16 20 12.8 20H6ZM9 6.6H12.6C13.8 6.6 14.3 7.4 14.3 8.4C14.3 9.4 13.8 10.2 12.6 10.2H9ZM9 13H13C14.4 13 15 13.9 15 15.3C15 16.7 14.2 17.5 12.8 17.5H9Z"
      />
    </Glyph>
  );
}

export function IconItalic(p: IconProps) {
  // A serifed "I" leaning forward — top and foot bars keep the slant from reading
  // as a stray stroke. (paper.design Plate 08, No. 26.)
  return (
    <Glyph {...p}>
      <path d="M9.5 5H16.5M7.5 19H14.5M14 5L10 19" />
    </Glyph>
  );
}

export function IconCode(p: IconProps) {
  // Two chevrons around a slash — the angle brackets of source. (paper.design
  // Plate 08, No. 27.)
  return (
    <Glyph {...p}>
      <path d="M9 8L4.5 12L9 16M15 8L19.5 12L15 16M13.2 6L10.8 18" />
    </Glyph>
  );
}

export function IconLink(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" />
    </Glyph>
  );
}

export function IconQuote(p: IconProps) {
  // Two filled quotation marks over a single indented line — borrowed words set
  // apart from your own. A left-bar-and-lines glyph would read as an indent
  // control. (paper.design Plate 08, No. 30.)
  return (
    <Glyph {...p}>
      <path
        fill="currentColor"
        stroke="none"
        d="M6.5 6.4H9.9V9.2C9.9 11.6 8.6 13.2 6.8 13.9L6.4 12.5C7.7 12.1 8.4 11.4 8.5 10.4H6.5ZM12.8 6.4H16.2V9.2C16.2 11.6 14.9 13.2 13.1 13.9L12.7 12.5C14 12.1 14.7 11.4 14.8 10.4H12.8Z"
      />
      <path d="M6.5 17.6H17" />
    </Glyph>
  );
}

export function IconBulletList(p: IconProps) {
  // Three filled dots, three lines — the dot is a thing, not a sentence.
  // (paper.design Plate 08, No. 28.)
  return (
    <Glyph {...p}>
      <path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20" />
      <circle cx="5" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function IconOrderedList(p: IconProps) {
  // The dots become numerals — sequence is the point. Hand-drawn 1/2/3 (lighter
  // 1.3 stroke) rather than font-dependent <text>. (paper.design Plate 08,
  // No. 29.)
  return (
    <Glyph {...p}>
      <path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20" />
      <path
        strokeWidth={1.3}
        d="M4.3 5.6L5.5 4.8L5.5 8.5M4.2 8.5H6.7M3.8 10.9C3.8 9.9 6 9.9 6 11.2C6 12.2 4.6 12.8 3.7 13.9H6.5M3.9 15.9C5 15.4 6.2 16 6.2 16.9C6.2 17.6 5.6 17.9 5 17.9C5.7 17.9 6.4 18.2 6.4 19.1C6.4 20.2 4.9 20.3 3.9 19.5"
      />
    </Glyph>
  );
}

export function IconDivider(p: IconProps) {
  // A rule parted by a single diamond — the printer's fleuron for a thematic
  // break. (paper.design Plate 08, No. 31.)
  return (
    <Glyph {...p}>
      <path d="M3.5 12H10M14 12H20.5" />
      <path d="M12 9.8L14.2 12L12 14.2L9.8 12Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function IconTable(p: IconProps) {
  // A bordered grid with its header row set in ink — the same filled band as the
  // frontmatter mark. The header band sits above the body dividers so the column
  // rule never crosses it. (paper.design Plate 08, No. 32.)
  return (
    <Glyph {...p}>
      <path d="M6 5H18Q20 5 20 7V9.4H4V7Q4 5 6 5Z" fill="currentColor" stroke="none" />
      <path d="M6 5H18Q20 5 20 7V17Q20 19 18 19H6Q4 19 4 17V7Q4 5 6 5Z" />
      <path strokeWidth={1.4} d="M12 9.4V19M4 14.2H20" />
    </Glyph>
  );
}

export function IconCodeBlock(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <polyline points="9 11 7.5 13 9 15" />
      <polyline points="14 11 15.5 13 14 15" />
    </Glyph>
  );
}

export function IconHeading(p: IconProps) {
  return (
    <Glyph {...p}>
      <line x1="7" y1="5" x2="7" y2="19" strokeWidth={1.8} />
      <line x1="17" y1="5" x2="17" y2="19" strokeWidth={1.8} />
      <line x1="7" y1="12" x2="17" y2="12" strokeWidth={1.8} />
    </Glyph>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <Glyph {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Glyph>
  );
}

export function IconParagraph(p: IconProps) {
  return (
    <Glyph {...p}>
      <path d="M9 5h7M12 5v14M9 5a3.5 3.5 0 0 0 0 7h3" />
    </Glyph>
  );
}
