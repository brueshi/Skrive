// Formatting glyphs for the Rich affordances (toolbar, selection bubble, slash
// menu). These are the paper.design "Text formatting" set — filled marks rather
// than the old line drawings, reconciled to currentColor: the two-tone source
// (navy ink + cyan accent) collapses to a single currentColor fill so the
// toolbar still drives inactive/active state by color exactly as before. Where
// the source used a lighter tone for hierarchy (table header vs body, the code
// frame vs the code lines, the paragraph mark vs its text), that survives as a
// fill-opacity tier rather than a second hue.
//
// Each icon keeps its original coordinates from the merged source artwork; the
// per-icon viewBox is a uniform 36-unit window (50 for the wider code block)
// centred on the glyph, so every mark renders at a consistent scale and weight
// without rewriting path data. IconChevronDown stays a line glyph — it has no
// counterpart in the new set.

type IconProps = { size?: number; className?: string };

function Glyph({
  size = 16,
  className = '',
  viewBox,
  children
}: IconProps & { viewBox: string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconBold(p: IconProps) {
  // A solid "B" — emphasis is weight, so the mark is ink. The two bowl counters
  // are evenodd holes.
  return (
    <Glyph {...p} viewBox="3.45 2.2 36 36">
      <path
        fillRule="evenodd"
        d="m28 19.3c2-0.9 2.8-2.8 2.8-5.3 0-3.4-2.3-6.5-7.3-6.5h-11.3c-0.7 0-1.3 0.6-1.3 1.3v22.8c0.1 0.8 0.6 1.3 1.3 1.3h11.3c5 0 8.5-2.4 8.5-7.3 0-3.1-1.4-5.3-4-6.3zm-10.9-6.9h4.6c1.7 0 2.8 0.9 2.8 2.5s-0.9 2.5-2.7 2.5h-4.7v-5zm5.9 15.3h-5.9v-5.8h5.4c2 0 3.2 1.1 3.2 2.9s-1 2.9-2.7 2.9z"
      />
    </Glyph>
  );
}

export function IconItalic(p: IconProps) {
  // A serifed "I" leaning forward — top and foot bars keep the slant readable.
  return (
    <Glyph {...p} viewBox="43.75 2.15 36 36">
      <path d="m70.2 7.4h-11.8c-0.9 0-1.4 0.4-1.5 1.1l-0.6 2.4c-0.1 0.8 0.3 1.3 1 1.3h3.5l-3.2 15.6h-3.8c-0.8 0.1-1.4 0.5-1.5 1.5l-0.6 2.4c-0.1 0.7 0.4 1.2 1 1.2h12.9c0.9 0 1.1-0.4 1.2-1l0.6-2.7c0.2-1-0.5-1.5-1.2-1.4h-3.2l3.3-15.6h3.5c0.8 0 1.2-0.3 1.4-1.1l0.6-2.5c0.1-0.7-0.2-1.2-0.9-1.2h-0.7z" />
    </Glyph>
  );
}

export function IconCode(p: IconProps) {
  // Two chevrons around a "c" — the angle brackets of source.
  return (
    <Glyph {...p} viewBox="82.35 2.05 36 36">
      <path d="m94.2 13.2-1.4-1.5c-0.5-0.5-1.2-0.5-1.7 0l-7.5 7.5c-0.5 0.5-0.5 1.3 0 1.7l7.5 7.5c0.4 0.6 1.1 0.6 1.6-0.1l1.4-1.4c0.5-0.5 0.5-1.2 0-1.7l-5.2-5.2 5.2-5.2c0.5-0.4 0.5-1.1 0.1-1.6z" />
      <path d="m106.2 13.3 1.4-1.5c0.5-0.6 1.2-0.7 2 0l7.5 7.4c0.5 0.5 0.5 1.2 0 1.7l-7.5 7.5c-0.5 0.5-1.2 0.6-1.8 0l-1.5-1.4c-0.5-0.5-0.6-1.2 0-1.7l5.3-5.3-5.3-5.2c-0.5-0.4-0.5-1.1-0.1-1.5z" />
      <path d="m95.9 18c0-2.5 1.6-2.9 3.5-2.9 1.4 0 3.8 0.1 4.8 0.2 0.5 0.1 0.3 2.5 0.2 2.5-0.8 0-2.7-0.1-3.9-0.1-1.3 0-1.3 0.3-1.3 1.1v2.5c0 1.1 0.3 1.2 1.4 1.1l3.4-0.2c0.8 0 0.6 1 0.6 2.4 0 0.2-3.3 0.3-5.3 0.3-2.1 0-3.3-0.6-3.3-2.8l-0.1-4.1z" />
    </Glyph>
  );
}

export function IconLink(p: IconProps) {
  // Two interlocked links of a chain.
  return (
    <Glyph {...p} viewBox="120 81.15 36 36">
      <path d="m136.1 105.2-0.4-0.1-3.3 3.2c-1.3 1.4-3.8 1.9-5.5 0-0.9-1.1-1-3.2 0.4-4.8l6.3-5.8c1.7-1.8 5.2-1.8 6.2 1.6 0.4 0.1 0.9-0.3 2.5-1.7 0.2-0.3 0.6-0.9 0.1-1.7-1.8-3.1-6.7-4.8-10.8-1.5l-7.1 6.5c-2.9 3.2-2 7.4-0.1 9.6 2.9 3.3 7.4 4.2 11.2 0.9l5.5-5.5c-1.5 0.2-3.1 0-5-0.7z" />
      <path d="m139.8 86.5-5 5.1c1.8-0.3 3.6 0 4.9 0.8l3.5-3.3c1.4-1.4 3.7-1.4 4.7 0 1.5 1.4 1.1 3.5 0 4.7l-5.8 5.6c-3.1 3.3-5.7 1-5.8-0.8-0.4-0.8-1.1-0.9-2.3 0.4l-0.9 0.7c-0.3 0.4-0.3 0.9 0 1.3 2.4 3.7 7.5 5.1 11.6 1.6l5.8-5.7c3.9-3.9 2.7-9-0.6-11.2-2.6-2.1-7-2.1-10.1 0.8z" />
    </Glyph>
  );
}

export function IconQuote(p: IconProps) {
  // A blockquote bar with two filled quotation marks — borrowed words set apart.
  return (
    <Glyph {...p} viewBox="120.95 2.1 36 36">
      <path d="m129.4 8.2v23.8c0 0.6-0.4 0.9-0.8 0.9h-1.5c-0.5 0-0.9-0.4-0.9-0.9v-23.7c0-0.5 0.4-1 0.9-0.9h1.4c0.5 0 0.9 0.3 0.9 0.8z" />
      <path d="m135.2 9.3h5.7c0.7 0 1.2 0.5 1.2 1.2v5.8c0 4.5-2.8 6.4-5.8 6.9-0.7 0.1-1.2-0.2-1.2-0.7l-0.3-1.5c-0.1-0.5 0.2-1.1 0.8-1.1 1.6-0.3 2.7-1.3 2.7-3.2h-2.9c-0.7 0-1.4-0.5-1.4-1.3v-4.9c0-0.7 0.6-1.2 1.2-1.2z" />
      <path d="m145.5 9.3h5c0.7 0 1.2 0.5 1.2 1.2v5.8c0 4.5-2.7 6.4-5.6 6.9-0.7 0.1-1.1-0.1-1.1-0.6l-0.3-1.4c-0.1-0.6 0.3-1.2 0.8-1.2 1.7-0.3 2.4-1.4 2.4-3.3h-2.4c-0.7 0-1.4-0.5-1.4-1.3v-4.9c0-0.7 0.6-1.2 1.4-1.2z" />
    </Glyph>
  );
}

export function IconBulletList(p: IconProps) {
  // Three square markers, three lines.
  return (
    <Glyph {...p} viewBox="5.15 40.65 36 36">
      <path d="m13.8 45.7h-5c-0.5 0-1 0.5-1 0.9v4.3c0 0.5 0.5 0.9 0.9 0.9h4.2c0.6 0 1-0.4 1-1v-4.2c0-0.5-0.4-0.9-0.1-0.9z" />
      <path d="m37.3 45.7h-19.2c-0.6 0-1.2 0.3-1.2 1v4c0 0.6 0.5 1.1 1.2 1.1h19.2c0.6 0 1.2-0.3 1.1-1.2v-4c0-0.5-0.4-0.9-1.1-0.9z" />
      <path d="m12.9 55.4h-4.1c-0.5 0-1 0.4-1 1.1v4.5c0.1 0.7 0.6 1.1 0.9 1h3.9c0.9 0.1 1.3-0.3 1.3-1v-4.4c0-0.7-0.4-1.2-1-1.2z" />
      <path d="m33.3 55.5h-15.2c-0.7 0-1.2 0.3-1.2 1.2v4.2c0 1.3 1 1.2 1.2 1.2h15.2c0.6 0 1.1-0.3 1.1-1.2v-4.2c0-0.7-0.5-1.2-1.1-1.2z" />
      <path d="m12.9 65.4h-4.1c-0.5 0-1 0.4-1 1.1v4.1c0 0.5 0.5 1 0.9 1h4.4c0.4 0 0.8-0.4 0.8-1v-4.2c0-0.5-0.3-1-1-1z" />
      <path d="m37.3 65.4h-19.2c-0.6 0-1.2 0.3-1.2 1.2v3.9c0 0.6 0.4 1.1 1.1 1.1h19.4c0.5 0 1.1-0.3 1.1-1v-4.1c0-0.6-0.3-1.1-1.2-1.1z" />
    </Glyph>
  );
}

export function IconOrderedList(p: IconProps) {
  // The markers become numbered tiles — sequence is the point. Each tile is one
  // evenodd path so the numeral reads as a knockout (clearest at 24px+).
  return (
    <Glyph {...p} viewBox="119.9 40.5 36 36">
      <path
        fillRule="evenodd"
        d="m128.9 44.4h-5.2c-0.6 0-1.1 0.5-1.1 1.1v5.3c0 0.8 0.5 1.2 1.1 1.2h5.4c0.7 0 1.1-0.4 1.1-1.1v-5.4c0-0.7-0.4-1.1-1.3-1.1z m-3 2.6-0.5-0.8 1.1-0.5h1l-0.1 4.7h-1.2v-3.7z"
      />
      <path
        fillRule="evenodd"
        d="m129.1 54.3h-5.4c-0.6 0-1.1 0.5-1.1 1.1v6c0 0.6 0.5 1.2 1.1 1.2h5.4c0.6 0 1.1-0.4 1.1-1v-6.2c0-0.6-0.5-1.1-1.1-1.1z m-4.6 5.4 2.1-1.6c0.3-0.2 0.3-0.5 0.3-0.6 0-0.4-0.2-0.5-0.7-0.5h-1.7v-1.1h2.2c1.1 0.1 1.5 0.5 1.5 1.5 0 0.7-0.3 1.1-0.7 1.3l-1.4 1.2h2.1v1h-3.7v-1.2z"
      />
      <path
        fillRule="evenodd"
        d="m129.1 64.6h-5.4c-0.7 0-1.1 0.5-1.1 1v5.8c0 0.5 0.5 1.1 1 1.1h5.6c0.6 0.1 1.1-0.4 1.1-1v-5.9c-0.1-0.6-0.5-1-1.2-1z m-4.6 6.2v-0.9h1.7c0.7 0 0.9 0 0.9-0.5 0-0.6-0.2-0.6-0.7-0.6h-1v-0.9h1.1c0.2 0 0.4-0.2 0.4-0.5s-0.2-0.5-0.5-0.5h-1.9v-0.8h2.1c1 0 1.6 0.3 1.6 1.1 0 0.7-0.3 1-0.6 1.2 0.4 0.1 0.8 0.5 0.8 1.4 0 1.1-0.8 1.2-1.8 1.2s-2.1-0.1-2.1-0.2z"
      />
      <path d="m152.1 45.9h-18.6c-0.5 0-1.1 0.4-1.1 1v2.4c0 0.6 0.5 1.1 1.1 1.1h18.6c0.6 0 1.1-0.5 1.1-1.1v-2.5c0-0.3-0.3-0.9-1.1-0.9z" />
      <path d="m152.1 55.9h-18.5c-0.6 0-1.2 0.4-1.2 1v2.9c0 0.6 0.5 1.1 1.1 1.1h18.6c0.6 0 1.1-0.5 1.1-1.1v-2.8c0-0.5-0.3-1.1-1.1-1.1z" />
      <path d="m152.1 66.2h-18.5c-0.5 0-1.2 0.4-1.2 1v2.7c0 0.6 0.4 1.1 1 1.1h18.7c0.6 0 1.1-0.5 1.1-1v-2.8c0-0.5-0.4-1-1.1-1z" />
    </Glyph>
  );
}

export function IconDivider(p: IconProps) {
  // A single thematic rule.
  return (
    <Glyph {...p} viewBox="5.15 80.7 36 36">
      <path d="m37.4 95.7h-28.6c-0.5 0-0.9 0.5-0.9 0.9v4c0 0.6 0.5 1.1 1.1 1.1h28.3c0.7 0 1.1-0.5 1.1-1.1v-4c0-0.5-0.4-0.9-1-0.9z" />
    </Glyph>
  );
}

export function IconTable(p: IconProps) {
  // A grid; the header row sits in full ink, the body cells one opacity tier
  // down — the same header-vs-body hierarchy the source carried in two tones.
  return (
    <Glyph {...p} viewBox="62.5 81.2 36 36">
      <path d="m72.8 84.1h-8.1c-0.5 0-1.1 0.2-1.1 1.1v4.2c0 0.5 0.4 1 1 1h8.2c0.7 0 0.9-0.5 0.9-1v-4.4c-0.1-0.5-0.4-0.9-0.9-0.9z" />
      <path d="m84.2 84.1h-7.9c-0.8 0-0.9 0.5-0.9 1.1v4.2c0 0.6 0.4 1 1 1h7.8c0.5 0 1-0.3 1-1v-4.5c0-0.4-0.2-0.8-1-0.8z" />
      <path d="m96.4 84.1h-8.2c-0.6 0-1 0.5-1 1v4.3c0 0.6 0.4 1 1 1h8.2c0.7 0 1-0.6 1-1v-4.4s0-0.9-1-0.9z" />
      <path fillOpacity={0.5} d="m72.7 92h-8.1c-0.6 0-1 0.4-1 1v3.9c0 0.7 0.4 1 0.9 1h8.2c0.7 0 1-0.3 1-0.9v-4c0-0.6-0.4-1-1-1z" />
      <path fillOpacity={0.5} d="m84.1 92h-7.8c-0.7 0-0.9 0.4-0.9 1.3v3.6c0 0.7 0.3 1 0.8 1h8c0.7 0 1-0.3 1-0.9v-4c0-0.6-0.2-1-1.1-1z" />
      <path fillOpacity={0.5} d="m96.4 91.9h-8.2c-0.6 0.1-1 0.3-1 1.1v3.9c0 0.7 0.4 1 0.9 1h8.4c0.6 0 0.9-0.3 0.9-0.9v-4.1c0-0.4-0.1-1-1-1z" />
      <path fillOpacity={0.5} d="m72.7 99.4h-8.1c-0.5 0-1 0.3-1 1.1v4.2c0 0.7 0.4 1 0.9 1h8.1c0.8 0 1.1-0.3 1.1-1v-4.2c-0.1-0.6-0.4-1.1-1-1.1z" />
      <path fillOpacity={0.5} d="m84.1 99.4h-7.7c-0.8 0-1 0.5-1 1.1v4.2c0 0.7 0.5 1 0.9 1h7.9c0.8 0 1-0.3 1-0.8v-4.5c0-0.6-0.3-1-1.1-1z" />
      <path fillOpacity={0.5} d="m96.4 99.4h-8.1c-0.7 0-1.1 0.3-1.1 1.1v4.2c0 0.6 0.3 1 0.9 1h8.4c0.5 0 0.9-0.3 1-0.8v-4.5c-0.1-0.4-0.2-1-1.1-1z" />
      <path fillOpacity={0.5} d="m72.6 107.5h-7.9c-0.6 0-1.1 0.4-1.1 1v4.6c0 0.6 0.4 1.1 1 1.1h8.1c0.7 0.1 1-0.3 1-1.1v-4.6c-0.1-0.6-0.5-1-1.1-1z" />
      <path fillOpacity={0.5} d="m84.1 107.5h-7.7c-0.6 0-1 0.3-1 1v4.6c0 0.6 0.3 1.1 1 1.1h7.8c0.7 0.1 1-0.4 1-0.9v-4.9c0-0.4-0.2-0.9-1.1-0.9z" />
      <path fillOpacity={0.5} d="m96.5 107.5h-8.3c-0.7 0-1 0.3-1 1v4.6c0 0.6 0.4 1.1 1 1.1h8.3c0.6 0 0.9-0.5 0.9-0.9v-4.9c0-0.5-0.4-0.9-0.9-0.9z" />
    </Glyph>
  );
}

export function IconCodeBlock(p: IconProps) {
  // Two large chevrons framing faint code lines — the block of source. The
  // chevrons are the ink; the lines sit at low opacity so they read as content.
  return (
    <Glyph {...p} viewBox="4.15 113.25 50 50">
      <path d="m14.4 125.4c-0.4 0-0.8 0.3-0.9 0.7l-6.7 11.6c-0.1 0.4-0.1 0.8 0.1 1.1l6.2 11.3c0.3 0.5 0.7 1.1 1.6 0.6l1.5-0.7c0.6-0.2 0.8-0.8 0.3-1.7l-5.7-10 5.7-10.4c0.4-0.6 0.2-1.3-0.3-1.6l-1.3-0.8c-0.2 0-0.4-0.1-0.5-0.1z" />
      <path d="m43.7 125.4c0.4-0.1 0.9 0.1 1.1 0.6l6.5 11.6c0.3 0.4 0.3 1 0.1 1.4l-6.6 11.4c-0.4 0.7-0.9 0.7-1.5 0.4l-1.8-0.9c-0.6-0.4-0.8-0.9-0.3-1.7l5.8-9.9-5.9-10.3c-0.4-0.6-0.4-1.3 0.4-1.7l1.4-0.8c0.2-0.1 0.3-0.1 0.8-0.1z" />
      <g fillOpacity={0.45}>
        <path d="m33.6 127.9h-14.2c-0.5 0-0.6 0.3-0.6 0.6v1.6c0 0.5 0.2 0.6 0.7 0.6l14.1 0.1c0.4 0 0.6-0.2 0.6-0.5v-1.8c0-0.4-0.2-0.6-0.6-0.6z" />
        <path d="m24.7 132.3h-5.4c-0.4 0-0.6 0.2-0.6 0.6v1.7c0 0.5 0.3 0.7 0.7 0.7h5.1c0.4 0 0.7-0.2 0.7-0.6v-1.7c0-0.3-0.1-0.7-0.5-0.7z" />
        <path d="m28 132.3h11.2c0.4 0 0.6 0.2 0.6 0.7v1.7c0 0.6-0.2 0.7-0.7 0.7h-11.8c-0.4 0-0.6-0.2-0.6-0.7v-1.7c-0.1-0.7 0.3-0.7 1.3-0.7z" />
        <path d="m19.4 136.8h8.6c0.5 0 0.8 0.2 0.8 0.6v1.6c0 0.6-0.3 0.7-0.7 0.7h-8.7c-0.4 0-0.6-0.2-0.6-0.6v-1.7c-0.1-0.3 0.2-0.6 0.6-0.6z" />
        <path d="m30.9 136.8h5.2c0.6 0 0.8 0.4 0.8 0.7v1.5c0 0.5-0.3 0.8-0.7 0.8h-5.3c-0.5 0-0.7-0.3-0.7-0.8v-1.6c0-0.3 0.3-0.6 0.7-0.6z" />
        <path d="m24.4 141.3h-5c-0.4 0-0.6 0.2-0.6 0.7v1.6c-0.1 0.4 0.2 0.7 0.6 0.7h5c0.6 0 0.8-0.2 0.7-0.7v-1.6c0.1-0.5-0.2-0.7-0.7-0.7z" />
        <path d="m27.5 141.3h11.6c0.5 0 0.7 0.3 0.7 0.7v1.6c0 0.4-0.2 0.7-0.6 0.7h-11.8c-0.4 0-0.7-0.2-0.7-0.6v-1.7c-0.1-0.4 0.2-0.7 0.8-0.7z" />
        <path d="m19.4 145.6h12.1c0.5 0 0.6 0.3 0.6 0.6v1.6c0 0.5-0.2 0.5-0.7 0.5h-12c-0.4 0-0.6-0.2-0.6-0.5v-1.6c-0.1-0.3 0.1-0.6 0.6-0.6z" />
      </g>
    </Glyph>
  );
}

export function IconHeading(p: IconProps) {
  // A solid "H".
  return (
    <Glyph {...p} viewBox="62.85 120.15 36 36">
      <path d="m91.4 125.7h-2.9c-0.9 0-1.4 0.5-1.4 1.4v8.6h-12.7v-8.7c0-0.7-0.5-1.3-1.2-1.3h-3.1c-0.9 0-1.3 0.6-1.3 1.3v22c0 0.8 0.6 1.6 1.3 1.6h3c0.9 0 1.4-0.6 1.4-1.3v-8.1h12.5l0.1 8c0 0.7 0.5 1.4 1.2 1.4h3.3c0.8 0 1.3-0.6 1.3-1.4v-22.2c0-0.9-0.7-1.3-1.5-1.3z" />
    </Glyph>
  );
}

export function IconChevronDown(p: IconProps) {
  // Line glyph — no counterpart in the filled set; kept as house style.
  return (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className ?? ''}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconParagraph(p: IconProps) {
  // A "P" with faint text lines — the body paragraph. The mark is the ink; the
  // lines sit one opacity tier down, the source's two-tone hierarchy.
  return (
    <Glyph {...p} viewBox="118.9 120.25 36 36">
      <path d="m131.5 124.9h-9.7c-0.7 0-1.2 0.4-1.2 1.2v24.3c0 0.6 0.4 1.1 1 1.2h3.3c0.6 0.1 1-0.5 1-1v-10.3h5.4c3.4 0 7.6-1.4 7.6-7.6 0-5.4-2.9-7.8-7.4-7.8zm-1 10.8h-4.6v-6.4h4.5c2.1 0 3 1.1 3 3.2s-1 3.2-2.9 3.2z" />
      <g fillOpacity={0.5}>
        <path d="m139.4 125.7v2c0 0.4 0.3 0.8 0.8 0.9h12.2c0.5 0 0.8-0.3 0.8-0.8v-2.2c0-0.6-0.4-0.8-0.7-0.8h-11.7c-0.4 0-0.9 0.3-1.2 0.7z" />
        <path d="m140.6 130.5h11.8c0.5 0 0.8 0.3 0.8 0.8v2.2c0 0.7-0.4 0.9-0.8 0.9h-11.8c-0.5 0-0.8-0.3-0.8-0.9v-2.2c0-0.5 0.3-0.8 0.8-0.8z" />
        <path d="m140.6 136.5h11.8c0.5 0 0.8 0.4 0.8 1v2.1c0 0.6-0.3 0.8-0.8 0.8h-11.8c-0.5 0-0.8-0.3-0.8-0.8v-2.3c0-0.6 0.3-0.8 0.8-0.8z" />
        <path d="m128 143.1v2c0 0.5 0.4 0.8 0.9 0.8h23.5c0.5 0 0.8-0.3 0.8-0.8v-2c0-0.4-0.3-0.8-0.7-0.8h-23.8c-0.4 0-0.7 0.4-0.7 0.8z" />
        <path d="m147.5 148.5v2.3c0 0.5-0.3 0.8-0.7 0.8h-18.1c-0.5 0-0.8-0.3-0.8-0.7v-2.4c0-0.4 0.3-0.8 0.7-0.8h18.2c0.4 0 0.7 0.3 0.7 0.8z" />
      </g>
    </Glyph>
  );
}
