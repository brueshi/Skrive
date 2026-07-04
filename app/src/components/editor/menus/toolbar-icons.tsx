// Formatting glyphs for the Rich affordances (toolbar, selection bubble, slash
// menu). Two families live here:
//
// - Marks (Bold / Italic / inline Code / Paragraph): flat currentColor fills
//   with fill-opacity tiers for hierarchy — formatting verbs stay monochrome
//   so the toolbar drives inactive/active state by color.
// - Block illustrations (heading tiles, lists, quote, code block, table,
//   divider, link): the duotone illustrated set. Structural ink rides
//   currentColor so menu rows still drive state; accent parts read
//   var(--skrive-accent) plus the --skrive-icon-accent-mid/-faint tints, and
//   sheet fills read var(--skrive-bg) — the family retunes with the theme.
//   Tokenized rather than the verbatim source palette (SKR-207): the source's
//   fixed slate ink and white sheets were theme-blind in dark mode.
//
// Each icon keeps its source artwork's coordinates with its own viewBox
// window. IconChevronDown stays a line glyph.

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

export function IconLink(p: IconProps) {
  // Interlocked chain links.
  return (
    <Glyph {...p} viewBox="0 0 128 128">
      <path d="m115.6 25.6-11.7-12.3c-6.4-6.6-17.2-7.7-25.1-0.8-0.3 0.4-29.8 29.6-29.8 29.6l16.5 5.1 3.5-6.2 18-17c1.6-1.9 4.9-2.1 6.6-0.5l10.2 10.5c2.6 2.2 2.2 6 1.2 7l-20 19h-2.1l-11.2 11-13.7-3-8.6 8.5v3.5l10.7 3-0.1 3 16.7 0.4s30.4-29 38.9-37.5c5.5-7.1 5-17.5 0-23.3z" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m117.8 31c-0.1 4-1 8.9-4.8 13.2-2 2.3-17.2 16.7-27 26.4-4.6 4.6-10.7 7.4-17.4 7.4-6.3 0-11.5-1.8-17.1-6.7l-2.5 5.7 9 5.2 4 1.8v2l12.7 0.4 7.9-3 4.8-6.4 28.6-28c3.8-4.5 6.6-12 1.8-18z" fill="var(--skrive-icon-accent-mid)"/>
      <path d="m23.1 114.4-11.2-11.4c-3.9-5.1-4.1-10-3.9-15 0.8 3.5 2 8.4 5.9 11.4l9.6 9.6c2.5 3.6 8.1 4.5 11.5 4.4 4.6 0 8.5-1.3 12-4.4l17-17.5c-2.9-0.4-4.7-0.9-7-1.8l4.1-5.7 16.6 0.4-27.8 30.1c-8 8-19.9 6.5-26.8-0.1z" fill="var(--skrive-icon-accent-mid)"/>
      <path d="m69.6 60c3.3 0.9 8.5-0.5 7.7-7l3.7 0.3 3 7.4-6.1 6.3-4.9 1h-2l-1.4-8z" fill="var(--skrive-icon-accent-mid)"/>
      <path d="m51.6 76c-1.7-5 1.2-8 4.4-8h3l1-3-6-6-8.3 6.2-2.5 3.8 8.4 7z" fill="var(--skrive-icon-accent-mid)"/>
      <path d="m55.6 55.5 0.4 3.5 3 5 5 4 8 1v-3l-4.5-6.4-4.9-5.6c-1.5-0.9-5.6-0.9-7 1.5z" fill="var(--skrive-accent)"/>
      <path d="m70 40.7 17.6-17.9 4.4-0.8 2.4 0.8 11.6 11.7 1 2.5-2 3-3 1-8.5-8.4c-1.4-1.2-3.5-1.2-4.9 0l-12.6 12.2-6-4.1z" fill="var(--skrive-accent)"/>
      <path d="m117.6 24.6-12.6-12.9c-3.7-3.9-8.2-5.7-13.2-5.7s-8.7 0.8-13.5 4.2c-3.9 3.4-66.8 65.6-67.4 66.3-3.6 3.9-5.6 8.8-5.6 14.6s2.2 10.8 5.8 14.7l9.9 10.2c3.9 3.7 8.6 6.1 15.2 6.2 5.4 0 10.2-1.5 14.8-5.6 3-2.8 66.1-64.6 66.5-65 3.5-3.8 5.2-8.4 5.2-13.6 0-5.1-1.7-9.7-5.1-13.4zm-69.7 88.8c-3 2.6-6.8 4.4-11.8 4.4-4 0-8.2-1.2-11.7-4.6l-10.2-10.4c-2.8-3-4.6-6.8-4.6-11.4s1.6-8.4 4.4-11.4l34.1-33.8c2.9-2.8 6.5-5.2 11.9-5.2 4 0 7.6 1.2 10.5 3.8 1.6 1.4 4.9 4.7 7 6.9 2.5 2.3 3.9 5.3 4.5 8.2-1.6 1.7-3 3.1-4 4.1s-2.6 2-3.7 2.3c-0.3-2.3-1.3-4.7-2.9-6.1l-7-6.8c-1.3-1.3-2.9-2.1-4.9-2.1s-3.5 0.7-4.6 1.5c-1.5 1.2-31.8 31.2-33.5 33-3 3.1-3 8.1 0.1 11.1l9.4 9.1c1.6 1.6 3.2 2.2 5.3 2.2 1.8 0 3.4-0.4 4.9-1.7l20.6-20.6c2.2 0.5 5.1 0.8 7.1 0.8 2.1 0 4-0.1 6.2-0.5l-27.1 27.2zm8.1-29.8 1 0.6-19 18.8c-0.6 0.5-1.1 0.8-1.8 0.8s-1.6-0.2-2.1-0.8l-9.6-9.4c-1.1-1.1-1.2-3-0.1-4.1l18.2-18.2c2.4 5.1 7 9.9 13.4 12.8v-0.5zm57.6-35.7-28 27.7c-4 3.5-9.5 6.4-16.7 6.4-7.9 0-13.5-3-16.8-5.9-2.1-1.7-4.6-5-5.9-8.2l7.4-7.3c0.4 3.4 2.6 6.5 5.4 8.5 3 2 6.1 2.5 10 2.5 4.9 0 9-1.4 12-4.1l25.6-25.5c1.5-1.6 2.4-3 2.4-5s-0.6-3.4-2-4.9l-11.4-10.7c-1.2-1-2.6-1.8-4.6-1.7-2 0-3.5 0.7-4.9 2l-18.1 16.7c-3.4-1.4-6.4-1.8-9.5-1.7-0.5 0-1 0-1.2 0.1l0.1-0.2 22.6-22c3.1-3 6.9-4.5 11-4.5 3.6 0 7 0.9 10.6 3.9l12.3 12.4c2.7 2.6 4.5 6.5 4.4 10.7 0 3.8-1.3 7.5-4.7 10.8zm-10.1-9.6-18 18.6c-1.4-3.5-3.6-5.9-4.6-6.9l-8.7-9.1 17-16c0.8-0.8 2.3-1 3.4-0.1l11.2 10.9c0.7 0.7 0.7 1.9-0.3 2.6zm-45.3 17.8c0.8-0.4 2.3-0.6 3.2 0.3l6.7 6.7c0.9 0.9 1.9 2.5 1.5 4-5.6 0.4-10.5-1.6-11.5-5.7-0.7-1.8-0.1-4.3 0.1-5.3z" fill="currentColor"/>
    </Glyph>
  );
}

export function IconQuote(p: IconProps) {
  // A quotation card with two set-apart marks.
  return (
    <Glyph {...p} viewBox="0 0 150 150">
      <path d="m137 26.5-13.6-13.9c-0.8-0.8-2.8-2.2-3.9-2.4l-2.7-0.6h-100.2c-5.3 0.1-10.2 4.6-10.2 10.3v97c0.1 3 0.8 5.3 3.1 7.6l12.3 12.4c2.1 2 4.1 3.4 7.3 3.4l1.2 0.1h103.3c0.2 0 10 1.2 10-10.2v-93.9c0-4-2.7-8.4-6.6-9.8zm-8.6-1h-97.5l-3.5 0.6-11-10.7v-0.3h100.2c1 0 1.9 0.4 2.5 1l9.3 9.4zm-116.3-6.6 10.8 10.9c-0.9 1.5-2.2 3.8-2.1 6.7v92.1l-7.7-8.1c-1-1.1-1.3-2.1-1.3-3.7l0.1-97.6 0.2-0.3z" fill="currentColor"/>
      <path d="m133.4 31.1h-102.4c-2.3 0-4.6 2.2-4.6 4.9l-0.1 93.9c0 3 2 5 4.6 5h102.8c2.1 0 4.2-1.7 4.3-4.3l-0.1-94.6c0-2.5-2.2-4.7-4.5-4.9z" fill="var(--skrive-bg)"/>
      <path d="m67.8 50.6c-12.7 2.6-21.1 13.3-21.3 29.3v12.8c0.1 3.2 2.5 5 4.6 5h14.8c2.2 0 4.4-1.9 4.4-4.5v-12.8c-0.2-2-1.7-4.6-4.7-4.6h-7.7c0-5.5 3.5-12.8 9.8-14l0.2-0.5-0.1-10.7z" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m101.7 50.6c-12.7 2.7-21.1 13.3-21.2 29.3v13.3c0.1 2.4 2.1 4.4 4.5 4.4h14.8c2.4 0 4.5-1.9 4.5-4.5v-12.7c0-2.5-1.8-4.6-4.2-4.6h-8.3c0.1-5.9 3.7-12.6 9.9-14l0.5-0.6-0.3-10.6h-0.2z" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m65.9 100.5h-14.6c-2.6 0-6.6-2-7.2-6.2l-0.1-1.7v-10.9c0-16.7 8.7-29.8 23-33.9 2-0.4 3.4 0.8 3.4 2.7v10.5s-0.5 2.5-2.8 2.9c-3.5 0.6-6.3 4.8-6.9 9.2h5.3c3.9 0 6.7 2.7 7 6.7l-0.1 13.7c-0.3 4-3.5 6.8-7 7zm-0.7-46.2c-7.7 2.8-15.2 10.5-15.8 25.6v13.2c0.1 1 0.9 1.9 1.9 1.9h14.5c1 0 1.9-0.9 1.9-2v-12.5c-0.1-1.5-0.8-2.2-1.9-2.2h-8c-1.6-0.1-2.7-1.2-2.7-2.7 0.1-6.6 3.8-14.3 10.1-16.7v-4.6z" fill="var(--skrive-accent)"/>
      <path d="m99.5 100.5h-14.5c-3.5 0-6.9-2.8-7-6.6v-12.3c0-17.2 8.8-29.7 21.8-33.6 2.7-0.8 4.6-0.2 4.6 2.6v10.9c-0.1 1.1-1.1 2.2-2.2 2.4-3.8 0.7-7 4.7-7.7 9.2h5.2c3.9 0 6.9 2.8 7.2 6.6l-0.1 13.7c-0.2 3.7-3.3 7-7.3 7.1zm-0.4-46.3c-7.3 2.7-15.8 10.4-15.9 25.7l0.1 13.2c0.1 1 0.8 1.9 1.8 1.9h14.4c1 0 2-0.5 2-1.9l0.1-12.9c0-1-0.9-1.9-1.9-1.9h-8.1c-1.6 0.1-2.6-1.2-2.6-2.7 0.1-6.6 3.6-13.8 10.1-16.7v-4.7z" fill="var(--skrive-accent)"/>
    </Glyph>
  );
}

export function IconBulletList(p: IconProps) {
  // Accent bead markers with ink lines.
  return (
    <Glyph {...p} viewBox="0 0 128 128">
      <g>
      <path d="m119.2 28.3h-74.2c-1-0.3-2.1-1.2-2.3-2.5 0-1.8 1.6-3.1 2.7-3.2h74.4c1 0.1 3.4 4-0.6 5.7z" fill="currentColor"/>
      <path d="m119.5 66.8h-74.6c-3-1.2-3.1-4.5 0.1-5.6h74.8c2.7 0.8 3 4.3-0.3 5.6z" fill="currentColor"/>
      <path d="m119.4 105.3h-74.4c-2.8-0.8-3.7-4.3-0.1-5.6h74.5c2.5 0.8 3.7 4.1 0 5.6z" fill="currentColor"/>
      </g>
      <circle cx="18.4" cy="25.6" r="12.4" fill="var(--skrive-accent)"/>
      <polygon points="27.9 17.2 28.3 17.9 29.6 20 30.8 23.3 30.9 25.8 30.8 28.1 28.7 32.9 26.1 35.4 23 36.7 20.1 37.4 16.6 37.4 13.7 36.5 10.8 35" fill="var(--skrive-accent)"/>
      <circle cx="18.4" cy="25.6" r="7.1" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m11.3 25.9c-0.1-4.3 3.4-7.7 7.1-7.7 1.6 0 3.5 0.5 4.4 1.4-6.2-0.8-9.5 2.6-9.3 7.5l1 3.5c-2.1-1-3.2-3.3-3.2-4.7z" fill="var(--skrive-icon-accent-mid)" opacity="0.5"/>
      <circle cx="18.1" cy="64" r="12.4" fill="var(--skrive-accent)"/>
      <polygon points="27.5 55.6 27.9 56.4 29.3 58.5 30.5 61.7 30.9 64.2 30.4 67.8 28.4 71.4 26.2 73.7 22.6 75.6 20.2 76.1 16.8 76.1 13.4 75.2 10.4 73.2" fill="var(--skrive-accent)"/>
      <circle cx="18.4" cy="64" r="7.1" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m11.1 64c-0.1-4 3.8-7.3 7.3-7.2 1.3 0.1 3.1 0.3 4.1 1.2-5.9-0.7-9.8 3.1-11.2 6.6v2.4c-0.1-1-0.2-1.4-0.2-3z" fill="var(--skrive-icon-accent-mid)" opacity="0.5"/>
      <circle cx="18.4" cy="102.4" r="12.4" fill="var(--skrive-accent)"/>
      <polygon points="27.2 94.1 28.7 95.8 29.8 97.9 30.8 100.6 30.7 104.6 29.8 107.4 28.2 109.9 25.3 112.6 23 113.9 20.8 114.6 17.9 114.8 15.4 114.5 12.6 113.4 10.1 111.6" fill="var(--skrive-accent)"/>
      <circle cx="18.4" cy="102.4" r="7.1" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m11.2 102.5c0-3.8 3.5-6.9 6.9-6.9 1.2 0 3.3 0.3 4.3 1-5.4-0.4-9.4 2.7-11.2 7.2v1.8c-0.1 0 0-2.3 0-3.1z" fill="var(--skrive-icon-accent-mid)" opacity="0.5"/>
    </Glyph>
  );
}

export function IconOrderedList(p: IconProps) {
  // Ink numerals with accent lines.
  return (
    <Glyph {...p} viewBox="0 0 85.1 77">
      <path d="m78.4 15.1h-54.7l-0.1-3.1h54.8z" fill="var(--skrive-accent)"/>
      <path d="M78.402 40.27L23.602 40.223L23.552 37.17L78.402 37.17L78.402 40.27Z" fill="var(--skrive-accent)"/>
      <path d="M78.452 64.87L23.652 64.823L23.602 61.77L78.452 61.77L78.452 64.87Z" fill="var(--skrive-accent)"/>
      <path d="m6.7 11.2c-1.4 0-2.3-1.6-1.4-2.7l4.5-4.2c1-1 2.7-0.3 2.7 1.1v14.1h2.5c1.9 0 2.1 3 0 3h-8.3c-1.6 0-1.9-3 0.1-3h2.5v-10.4l-1.8 1.8c-0.3 0.3-0.6 0.3-0.8 0.3z" fill="currentColor"/>
      <path d="m4.1 34.6c0-3.4 2.7-6.2 6.1-6.1 4.2-0.1 6.6 2.9 6.5 6.1 0 1.8-0.7 3.1-1.9 4.5l-5.7 5.5h6.6c1.6 0 2.2 3 0 3.1h-10.7c-1.2 0-2.2-1.6-0.8-2.8l8.2-7.9c0.7-0.6 1.1-1.5 1.1-2.4 0-1.6-1.1-3-3.1-3-1.7 0-3.3 1.3-3.3 3 0 1.9-3 2.5-3 0z" fill="currentColor"/>
      <path d="m3.6 66.7c0.5-1.3 1.5-1.5 2.1-1.2 0.8 0.3 1 1 1 1.3 0 1.7 1.5 3.1 3.6 3.1s3.5-1.4 3.5-3c0-1.8-1.9-2.8-3.3-2.8-1.9 0.1-2.3-3 0-3 1.4 0.1 3-0.7 3-2.5 0-1.6-1.1-2.9-3.3-2.9-1.5 0-3.1 1-3.2 2.8-0.2 2.2-3.1 2.2-3.1 0 0-2.5 2.2-6.3 6.7-6.2 3.2 0 6.1 2.2 6.1 5.8 0 1.9-0.7 3.1-1.7 4.4 1.1 0.9 2.1 2.4 2.1 4.3 0 3.3-2.7 6.3-6.7 6.3-4.5 0-6.8-3-6.8-6.3v-0.1z" fill="currentColor"/>
    </Glyph>
  );
}

export function IconDivider(p: IconProps) {
  // A capsule over the thematic rule.
  return (
    <Glyph {...p} viewBox="0 0 155 52">
      <path d="m146 26.1h-137.3" fill="none" stroke="currentColor" strokeWidth="5.199" strokeLinecap="round" strokeMiterlimit="10"/>
      <path d="m87.8 42.8h-20.7c-8.5 0-16.1-7.2-16.4-15.9v-1.1c0.3-8.6 7.1-16.8 16.4-16.8h20.9c8-0.2 16.3 6.2 17.1 15v2.7c-0.4 8.7-8.7 16.1-17.3 16.1z" fill="var(--skrive-bg)"/>
      <path d="m87.8 11.8c7.2 0 13.8 6.3 13.8 14.2s-5.6 14.2-13.8 14.2h-20.7c-7.6 0-13.6-6-13.6-14s5.9-14.4 13.6-14.4h20.7m0.1-5.2h-20.8c-9.9 0-18.1 7.9-18.9 17.1v3.7c1 10.4 8.5 17.8 18.9 17.8h20.7c10.1 0 18.5-7.3 19-17.7v-3.5c-0.8-9.5-8.5-17.4-18.9-17.4z" fill="currentColor"/>
      <path d="m87.4 36.1h-19.9c-5.1 0-9.8-4.1-9.8-9.9 0-5.1 4.1-10.1 9.8-10.1h20c6.1 0 9.7 5.5 9.7 10 0 5.1-3.8 10-9.8 10z" fill="var(--skrive-accent)"/>
      <path d="m87.1 31h-19.4c-2.7 0-4.8-2.1-4.8-4.8 0-2.4 2-5 4.8-5h19.4c2.8 0 5.1 2.2 5.1 4.9s-2.2 4.9-5.1 4.9z" fill="var(--skrive-icon-accent-faint)"/>
    </Glyph>
  );
}

export function IconTable(p: IconProps) {
  // A tilted sheet of cells, header column in accent.
  return (
    <Glyph {...p} viewBox="0 0 128 128">
      <path d="m118 17.4-14.3-9.7c-2.7-1.7-5.7-2.1-8.7-2-2 0.1-4.3 0.5-6.2 0.9l-75 15.4c7.5-0.3 1.3 0.2-0.8 1.5-3.6 1.6-7 5.9-7 10.1v71.4c0.2 3 1.4 6.2 4.5 8.3l11.8 7.7c1.7 1.3 4 1.6 5.3 1.3l86.4-17.1c4.1-0.8 8.2-4.3 8.2-9.7v-70.4c0-3.1-1.1-6-4.2-7.7z" fill="currentColor"/>
      <path d="m10.2 32.4 10.7 6.5c-0.7 1.7-0.9 3.5-0.9 5.1v69.7l-7-4.5c-1.2-0.9-2.8-2.8-2.8-4.9v-71.9z" fill="var(--skrive-bg)"/>
      <path d="m12.4 28.6c1.1-1.3 2.6-2.1 4.2-2.3l76.1-15.7c1.8-0.4 6.2-1.2 9 0.7l7.6 5.2-78.7 14.8c-2.4 0.5-5.5 2.2-7.3 4.1l-10.9-6.8z" fill="var(--skrive-bg)"/>
      <path d="m25 43.6v8.4l18.5-4v-14.4l-11.5 1.9c-3.5 0.6-7 3.8-7 8.1z" fill="var(--skrive-accent)"/>
      <polygon points="25.1 56.7 25.1 67.7 43.5 63.9 43.5 52.8" fill="var(--skrive-accent)"/>
      <polygon points="25.1 72.4 25.1 84.6 43.5 80.5 43.5 68.5" fill="var(--skrive-accent)"/>
      <polygon points="25.1 89.6 25.1 99 43.5 95.4 43.5 85.1" fill="var(--skrive-accent)"/>
      <path d="m25.1 103.5v12.4c0 1.1 0.9 2.1 1.9 1.9l16.5-3v-15.1l-18.4 3.8z" fill="var(--skrive-accent)"/>
      <polygon points="48 32.8 48 46.9 67.5 42.4 67.5 29.3" fill="var(--skrive-accent)"/>
      <polygon points="48 51.8 48 63 67.5 58.7 67.5 47.3" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="48 67.5 48 79.4 67.5 75.1 67.5 63.3" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="48 84 48 94.3 67.5 90.1 67.5 79.4" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="48 99 48 113.8 67.5 109.7 67.5 95" fill="var(--skrive-icon-accent-faint)"/>
      <polyline points="72.2 28.3 92.7 24.5 92.7 37.1 72.2 41.2" fill="var(--skrive-accent)"/>
      <polygon points="72.2 46.2 92.7 41.6 92.7 53.3 72.2 57.7" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="72.2 62.3 92.7 57.9 92.7 69.2 72.2 73.9" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="72.2 78.4 92.7 73.8 92.7 84.6 72.2 89.1" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="72.2 93.9 92.7 89.7 92.7 104.6 72.2 108.9" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="97.3 40.4 117.7 36.4 117.7 47.7 97.3 52.3" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="97.3 56.9 117.7 52.5 117.7 63.6 97.3 68.1" fill="var(--skrive-icon-accent-faint)"/>
      <polygon points="97.3 72.9 117.7 68 117.7 79.5 97.3 83.6" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m97.3 88.6 20.4-4.4v11.3c0 2-1.7 4.4-3.7 5l-16.8 3.4 0.1-15.3z" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m97.3 23.6v12.6l20.3-4.1v-7.5c0-2.6-2.1-4.6-4.4-4.1l-15.9 3.1z" fill="var(--skrive-accent)"/>
    </Glyph>
  );
}

export function IconCodeBlock(p: IconProps) {
  // A titled editor window with chevroned source.
  return (
    <Glyph {...p} viewBox="0 0 115 96">
      <path d="m102.6 2.4h-90.3c-3.8 0.2-7.3 3.5-7.3 7.5v76.1c0 3.9 3.2 7.4 7.3 7.4h90.3c4 0 7.4-3.4 7.4-7.4v-75.9c0-3.9-3.4-7.5-7.4-7.7z" fill="currentColor"/>
      <path d="m105.6 19.3v-8.8c0-1.6-1.4-3.8-3.3-3.8h-89.7c-1.6 0-3.5 1.7-3.5 3.4v8.9 0.3h96.5z" fill="var(--skrive-bg)"/>
      <path d="m9.1 23.1v62.9c0 1.6 1.4 3.2 3 3.2h90.5c1.7 0.2 3.1-1.2 3.1-3.2l-0.1-62.9h-96.5z" fill="var(--skrive-bg)"/>
      <path d="m18.7 10.9h-1.6c-1.1 0-2.1 1-2.1 2.2s1 2.2 2.2 2.2h1.6c1.2 0 2.1-0.9 2.1-2.1s-0.9-2.3-2.2-2.3z" fill="currentColor"/>
      <path d="m28.9 10.9h-1.5c-1.1 0-2.2 0.8-2.3 2.1 0 1.3 1 2.3 2.2 2.3h1.6c1.2 0 2.2-0.8 2.2-2.1 0-1.2-0.9-2.3-2.2-2.3z" fill="currentColor"/>
      <path d="m39.2 10.9h-1.6c-1.1 0-2.2 0.8-2.2 2.2 0 1.2 0.9 2.2 2.2 2.2h1.6c1.3 0 2.2-0.7 2.2-2s-0.9-2.4-2.2-2.4z" fill="currentColor"/>
      <path d="m94.8 28.5h-74.9c-2.2 0-4.9 2.1-4.9 5v45.3c0 2.6 2.1 4.9 4.9 4.9h74.7c2.6 0 5.3-2 5.3-4.9v-45.2c0-2.6-2.4-5.1-5.1-5.1z" fill="var(--skrive-accent)"/>
      <path d="m94.6 33h-74.4c-0.4 0-0.9 0.3-0.9 0.8v45c0 0.4 0.4 0.7 0.8 0.7h74.4c0.5 0 0.9-0.3 0.9-0.8v-44.9c0-0.4-0.4-0.8-0.8-0.8z" fill="var(--skrive-icon-accent-faint)"/>
      <path d="m39 37.1h-13.3c-1.1 0-2.2 0.9-2.2 2.2s1.1 2.1 2.2 2.1h13.3c1.2 0 2.2-0.8 2.2-2.1 0-1.1-0.9-2.2-2.2-2.2z" fill="currentColor"/>
      <path d="m32.5 63.6h-6.7c-1.2 0-2.3 0.8-2.3 2.1s1 2.2 2.2 2.2h6.8c1.2 0 2.2-0.9 2.2-2.1s-1-2.2-2.2-2.2z" fill="currentColor"/>
      <path d="m38.9 71.4h-13.2c-1.1 0-2.2 0.8-2.2 2.2 0 1.3 1.1 2.1 2.2 2.1h13.1c1.3 0 2.3-0.8 2.3-2s-1-2.3-2.2-2.3z" fill="currentColor"/>
      <path d="m68.5 71.3h-21c-1.1 0-2.1 0.8-2.1 2.2 0 1.1 0.9 2 2.1 2.1h21c1.1 0 2.2-0.8 2.2-2s-1.1-2.3-2.2-2.3z" fill="currentColor"/>
      <path d="m60.9 40.7c-1-0.1-2 0.5-2.4 1.7l-6.3 22.1c-0.3 1 0.3 2.6 1.5 2.8 1.3 0.3 2.3-0.3 2.6-1.5l6.1-22.1c0.5-1.6-0.4-2.9-1.5-3z" fill="currentColor"/>
      <path d="m48.5 44.4c-0.7-0.5-1.9-0.6-2.8 0.2l-9 8.2c-0.9 0.9-1 2.4 0.1 3.4l8.7 7.7c0.9 0.7 2.3 0.7 3.1 0 0.7-0.8 0.9-2.3-0.1-3.1l-7-6.5 7-6.6c1-0.9 0.9-2.4 0-3.3z" fill="currentColor"/>
      <path d="m69.4 44.6c-0.8-0.8-2.2-0.8-3-0.1-0.8 0.8-0.9 2.2 0.1 3.2l7.1 6.6-7.1 6.4c-1 0.9-0.9 2.4-0.1 3.2 0.8 0.6 2.1 0.6 2.9 0l8.7-7.7c0.9-0.8 1.2-2.3 0.2-3.4l-8.8-8.2z" fill="currentColor"/>
    </Glyph>
  );
}

// (The generic solid-H IconHeading this set replaces lives in git history.)
//
// The heading tiles: an H + level numeral on a rounded card, one icon per
// level, derived from a single three-card source artwork (each icon's viewBox
// is its card's window; path data keeps the source coordinates). Colors are
// reconciled to the house rule above: the source's grey frame / grey H / blue
// numeral collapse to currentColor — the card ring survives as the chrome
// opacity tier, the letterforms take full ink. The frame is a true evenodd
// knockout (outer rect + inner face as one path), not a white face, so the
// icon composes over any row fill.

export function IconHeading1(p: IconProps) {
  return (
    <Glyph {...p} viewBox="6.5 2.05 41.4 41.4">
      <path
        fillRule="evenodd"
        fillOpacity={0.45}
        d="m43.6 43.1h-33.1c-2.2 0-4-1.8-4-4.2v-32c0-2.3 1.8-4.5 4.1-4.5h33.3c2.3 0 4 1.9 4 4.5v32.1c0 2.3-1.8 4.1-4.3 4.1z M43.6 4.5h-33.2c-1.2 0-2 1.1-2 2.4v31.9c0 1.3 0.9 2.4 2.1 2.4h33.1c1.3 0 2.4-1 2.4-2.3l-0.1-32c0-1.4-1-2.4-2.3-2.4z"
      />
      <path d="m29.6 31.6h-4v-7.2h-6.9v7.2h-4.2v-17.1h4.2v6.7h6.8v-6.7h4.1v17.1z" />
      <path fill="var(--skrive-accent)" d="m39.6 31.6h-3.6v-13l-4.1 1.3v-2.9l7.3-2.5h0.4v17.1z" />
    </Glyph>
  );
}

export function IconHeading2(p: IconProps) {
  return (
    <Glyph {...p} viewBox="57.45 2.05 41.4 41.4">
      <path
        fillRule="evenodd"
        fillOpacity={0.45}
        d="m94.1 43.1h-32.2c-2.3 0-4.4-1.7-4.4-4.2v-32c0-2.3 1.8-4.5 4.3-4.5h32.4c2.5 0 4.2 1.9 4.1 4.5v32c0.2 2.4-1.6 4.2-4.2 4.2z M94.2 4.5h-32.3c-1.2 0-2.4 1-2.4 2.3v32.1c0 1.3 1 2.3 2.2 2.3h32.5c1.3 0 2.3-1 2.3-2.3v-32c0-1.4-1-2.4-2.3-2.4z"
      />
      <path d="m78.1 31.6h-4v-7.2h-6.5v7.2h-4v-17.1h4v6.7h6.4v-6.7h4v17.1h0.1z" />
      <path fill="var(--skrive-accent)" d="m92.4 31.6h-12v-2.5l5.5-5.7c1.4-1.4 2.1-2.7 2.1-3.9s-0.6-2.3-2.2-2.3-2.3 1.2-2.3 2.7h-3.5c0-3 2.1-5.6 5.8-5.6 3.8 0 5.8 2 5.8 4.9 0 2.6-1.7 4.2-3.3 5.9l-3.4 3.5h7.5v3z" />
    </Glyph>
  );
}

export function IconHeading3(p: IconProps) {
  return (
    <Glyph {...p} viewBox="107.9 2.15 41.5 41.5">
      <path
        fillRule="evenodd"
        fillOpacity={0.45}
        d="m145.2 2.5c-0.3-0.1-0.6-0.1 0-0.1h-32.9c-2.2 0-4.4 1.8-4.4 4.3v32.2c0 2.4 1.8 4.2 4.3 4.2h33.1c2.3 0 4.1-1.8 4.1-4.2v-32.1c0-2.3-1.7-4.3-4.2-4.3z M145.1 4.6c-0.2-0.1-0.2-0.1 0-0.1h-32.8c-1.1 0-2.5 0.9-2.5 2.3v32.1c0 1.3 1 2.3 2.3 2.3h33c1.2 0 2.3-1 2.3-2.3l-0.1-32.1c0-1.2-0.9-2.2-2.2-2.2z"
      />
      <path d="m129 31.6h-4.2v-7.2h-6.5v7.2h-4.1v-17.1h4.1v6.7h6.5v-6.7h4.2v17.1z" />
      <path fill="var(--skrive-accent)" d="m135.4 21.6h1.9c1.2-0.2 2.2-0.9 2.1-2.3 0-1.2-0.9-2.1-2.2-2.1-1.4-0.1-2.1 0.8-2.2 1.9h-3.6c0.1-2.6 2-4.8 5.7-4.8s5.8 1.8 5.8 4.7c0.1 1.7-0.8 3.1-2.3 3.9 1.7 0.6 2.8 2.1 2.8 4 0 3.3-2.7 5-6.1 5-3.6 0-6.2-1.9-6.3-5.1h3.7c0.1 1.2 1 2.2 2.6 2.2s2.5-0.8 2.4-2.3c0-1.6-1.2-2.4-2.7-2.4h-1.6v-2.7z" />
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
