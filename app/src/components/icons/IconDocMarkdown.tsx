type Props = {
  size?: 16 | 24;
  className?: string;
};

// Filled, multi-tone markdown document (paper.design): a folded page carrying
// markdown's first symbol, the hash. The hash is the ink; the body lines stay
// faint so the # reads as the subject. Tones resolve from the
// --skrive-icon-doc-* tokens, tuned per theme (see index.css).
export function IconDocMarkdown({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 145.9 177"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="m132.9 41.8-29.3-28.4c-1.7-1.8-4.2-2.9-7.6-2.9h-72.2c-6.7 0-13.2 5.1-13.2 12.3v131.7c0 6.5 5.3 12.2 12.7 12.2h99.6c7.3 0 13-4.9 13-12.2v-105.9c0-2.5-1-5.1-3-6.8z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m128.1 48.8v105.6c0 2.8-2.2 4.9-5.5 4.9h-99.2c-3 0-5.4-2.5-5.4-5.5v-130.4c0-3 2.4-5.6 5.7-5.6h74.9l0.1 19.7c0 5.9 4.3 11.3 10.9 11.3h18.5z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m95.8 17.6 0.1 19.9c0 5.9 4.3 11.2 10.6 11.3l21.6 0.1-29.5-31.3h-2.8z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m64.9 35.8-2 10.7h-9.5l1.9-10.6h-7.9l-2.1 10.6h-9.5l0.1 7.2h8.2l-2.1 10.9h-8.9v8.1h7.6l-2.3 11h8l2.1-11h9.7l-1.9 11h7.7l1.9-11h9.1v-8.1h-8l1.9-10.9h8.7v-7.2h-7.5l2.2-10.7h-7.4zm-3.5 17.9-1.9 10.9h-9.6l2.1-10.9h9.4z"
        fill="var(--skrive-icon-doc-ink)"
      />
      <line
        x1="32.6"
        x2="113.1"
        y1="102.3"
        y2="102.3"
        stroke="var(--skrive-icon-doc-faint)"
        strokeWidth="6.288"
      />
      <line
        x1="32.6"
        x2="113.1"
        y1="119.5"
        y2="119.5"
        stroke="var(--skrive-icon-doc-faint)"
        strokeWidth="6.288"
      />
      <line
        x1="32.6"
        x2="89.8"
        y1="137.7"
        y2="137.7"
        stroke="var(--skrive-icon-doc-faint)"
        strokeWidth="6.288"
      />
    </svg>
  );
}
