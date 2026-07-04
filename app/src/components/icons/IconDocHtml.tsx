type Props = {
  size?: 16 | 24;
  className?: string;
};

// Filled, multi-tone HTML document (SKR-205), sibling of IconDocText/IconDocMarkdown.
// A folded page carrying the `</>` code glyph as its subject where Markdown carries
// the hash and plain text carries "TXT". The glyph is the ink; the body lines stay
// faint so the mark reads as the subject. Tones resolve from the shared
// --skrive-icon-doc-* tokens (see index.css) so it stays theme-aware and matches the
// other document glyphs exactly.
export function IconDocHtml({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="m15.4 4c-1.9 0-3.4 1.5-3.4 3v50c0 1.9 1.5 3.6 3.4 3.6h35.1c2.1 0.4 4.5-1.5 4.5-3.8v-40c0-0.7-0.4-1.1-0.8-1.5l-12.8-11.7c-0.4-0.4-1-0.6-1.6-0.6h-24.4v1z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m13.9 3.8c-1.9 0-3.6 1.5-3.6 3.2v49c0 2 1.7 3 3.6 3h35.1c1.9 0 3.4-1 3.4-3v-39.2l-12-12-0.8-1h-25.7z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m52.4 16.8v39.2c0 1.7-1.3 2.8-3.4 2.8h-35.5c-1.5 0-3.3-0.7-3.3-2.4v-49.2c0-1.7 1.6-3.4 3.5-3.4h25.1c0.5 0 0.8 0 1.1 0.4l12.5 11.7c0.1 0.2 0 0.5 0 0.9z"
        fill="none"
        stroke="var(--skrive-icon-doc-edge)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeMiterlimit="10"
      />
      <path
        d="m39.4 4.6 0.1 8.8c0 1.3 1.3 2.5 2.5 2.5h9.8l-12.4-11.3z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m39.4 4.2v9.2c0 1.3 1 2.5 2.6 2.6h9.8"
        fill="none"
        stroke="var(--skrive-icon-doc-edge)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeMiterlimit="10"
      />
      <path
        d="m24.3 20.7-5.8 4.3c-0.9 0.8-0.9 1.8 0.2 2.5l5.5 3.7c1.5 0.4 2.6-1 1.7-2.2l-4-2.7 3.8-2.9c1.2-0.9 0.3-3-1.4-2.7zm14.5 0c-0.6-0.3-1.1-0.2-1.6 0.3s-0.5 1.7 0.1 2.2l3.5 2.9-3.7 2.9c-1.1 1.1 0.2 2.9 1.7 2.1l5.4-3.6c1.1-0.6 1.1-1.9 0.2-2.5l-5.6-4.3zm-5.3-1.9c-0.6 0-1 0.3-1.3 0.9l-4.1 11.7c-0.1 1.5 2.1 2.2 2.6 0.7 0.4-0.6 3.5-9.7 3.8-11.1 0.3-1-0.2-2.1-1-2.2z"
        fill="var(--skrive-icon-doc-ink)"
        stroke="var(--skrive-icon-doc-ink)"
        strokeWidth="1.108"
        strokeLinejoin="round"
        strokeMiterlimit="10"
      />
      <line
        x1="19.1"
        x2="43.6"
        y1="37.1"
        y2="37.1"
        stroke="var(--skrive-icon-doc-faint)"
        strokeWidth="2.064"
        strokeLinecap="round"
        strokeMiterlimit="10"
      />
      <path
        d="m19 40c-0.8 0-1.5 2 0.1 2.2h7.4c1.4 0 1.2-2.1 0.1-2.1h-7.6v-0.1z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m30.2 40c-1.2 0-1.3 2.1 0 2.1h8.3c1.1 0 1.3-2 0-2.1h-8.3z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m19 45.2c-0.8 0-1.4 1.8-0.1 2.1h15.2c1.3 0 1.5-2.1 0.1-2.1h-15.2z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m38.2 45.3c-0.9-0.1-1.6 2 0 2h5.6c1.1 0 0.9-2 0-2h-5.6z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m19 49.7c-0.8 0-1.5 1.8 0 2h14.4c1.2 0 1.7-1.8 0.1-2h-14.5z"
        fill="var(--skrive-icon-doc-faint)"
      />
    </svg>
  );
}
