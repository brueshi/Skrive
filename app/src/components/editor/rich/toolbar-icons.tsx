// INTERIM formatting glyphs for the Rich affordances (toolbar, selection bubble,
// slash menu). These are placeholders in the house style — 24x24 grid,
// currentColor, ~1.6 stroke — so the affordances can be validated now. The fixed
// bar is the agreed home for custom Skrive iconography (master plan, Stage 3);
// when the real marks are drawn in paper.design they replace these one-for-one,
// ideally promoted into components/icons/ as individual files. Until then they
// live together here, to be redrawn together.

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
  // A weighted "B" glyph — cleaner than a hand-drawn path and consistent with the
  // Notion-style toolbar's letter marks.
  return (
    <Glyph {...p} fill="currentColor">
      <text
        x="12"
        y="17.5"
        textAnchor="middle"
        fontSize="17"
        fontWeight="800"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        fill="currentColor"
        stroke="none"
      >
        B
      </text>
    </Glyph>
  );
}

export function IconItalic(p: IconProps) {
  return (
    <Glyph {...p}>
      <line x1="10" y1="5" x2="17" y2="5" />
      <line x1="7" y1="19" x2="14" y2="19" />
      <line x1="14" y1="5" x2="10" y2="19" />
    </Glyph>
  );
}

export function IconCode(p: IconProps) {
  return (
    <Glyph {...p}>
      <polyline points="9 8 5 12 9 16" />
      <polyline points="15 8 19 12 15 16" />
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
  // Two opening quotation marks — unambiguous, where a left-bar-and-lines glyph
  // reads as an indent control.
  return (
    <Glyph {...p} fill="currentColor">
      <path d="M9 8.5c-2 .4-3.4 1.9-3.4 4 0 1.7 1.1 2.9 2.7 2.9 1.2 0 2.1-.85 2.1-2 0-1.05-.75-1.85-1.8-1.85-.2 0-.45.03-.6.08.18-1 1-1.85 2.15-2.25L9 8.5ZM17 8.5c-2 .4-3.4 1.9-3.4 4 0 1.7 1.1 2.9 2.7 2.9 1.2 0 2.1-.85 2.1-2 0-1.05-.75-1.85-1.8-1.85-.2 0-.45.03-.6.08.18-1 1-1.85 2.15-2.25L17 8.5Z" />
    </Glyph>
  );
}

export function IconBulletList(p: IconProps) {
  return (
    <Glyph {...p}>
      <line x1="9" y1="6" x2="19" y2="6" />
      <line x1="9" y1="12" x2="19" y2="12" />
      <line x1="9" y1="18" x2="19" y2="18" />
      <circle cx="5" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function IconOrderedList(p: IconProps) {
  return (
    <Glyph {...p}>
      <line x1="10" y1="6" x2="19" y2="6" />
      <line x1="10" y1="12" x2="19" y2="12" />
      <line x1="10" y1="18" x2="19" y2="18" />
      <text x="3" y="8" fontSize="7" fill="currentColor" stroke="none">
        1
      </text>
      <text x="3" y="14" fontSize="7" fill="currentColor" stroke="none">
        2
      </text>
      <text x="3" y="20" fontSize="7" fill="currentColor" stroke="none">
        3
      </text>
    </Glyph>
  );
}

export function IconDivider(p: IconProps) {
  return (
    <Glyph {...p}>
      <line x1="4" y1="12" x2="20" y2="12" />
    </Glyph>
  );
}

export function IconTable(p: IconProps) {
  return (
    <Glyph {...p}>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <line x1="4" y1="10" x2="20" y2="10" />
      <line x1="12" y1="5" x2="12" y2="19" />
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
