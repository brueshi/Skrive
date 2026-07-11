type Props = {
  size?: 16 | 24;
  className?: string;
};

// Filled, multi-tone plain document (paper.design): a folded page of text with
// no markdown hash, the sibling of IconDocMarkdown. Used for non-markdown files
// in the tree / the summon fan. Currently dormant — the tree shows markdown only — but wired
// so it surfaces the moment other file types appear. Tones resolve from the
// --skrive-icon-doc-* tokens, tuned per theme (see index.css).
export function IconDoc({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 115 117"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="m98.6 26.8-20.3-19.6c-1.1-1.1-2.5-1.8-4.5-1.8h-50.8c-4.2 0-8.6 3.2-8.6 8v90.6c0 4.3 3.6 7.6 8.2 7.6h69.2c4.8 0 8.9-2.6 8.9-7.6v-73c0-1.6-0.5-3-2.1-4.2z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m72.9 10.3v12.5c0 3.2 1.7 8.4 8.1 8.4l14.2 0.1v72.3c0 1.8-1.5 3.1-3.3 3.1h-68.9c-1.7 0-3.6-1.3-3.6-3.1v-89.7c0-1.9 1.7-3.6 3.6-3.6h49.9z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m72.9 10.2v12.8c0 3.8 2.1 8.2 7.4 8.2l15.1 0.1-22.5-21.1z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <polygon points="64.2 27.1 29.6 27 29.6 22.6 64.2 22.6" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="64.2 37.8 29.6 37.8 29.6 33.6 64.2 33.6" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="84.9 49.6 29.6 49.6 29.6 45.2 84.9 45.2" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="84.8 60.9 29.6 60.9 29.6 56.5 84.8 56.5" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="84.8 71.8 29.6 71.8 29.6 67.5 84.8 67.6" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="84.8 83.4 29.6 83.4 29.6 78.6 84.8 78.6" fill="var(--skrive-icon-doc-ink)" />
      <polygon points="68.7 94.4 29.6 94.4 29.6 90.3 68.7 90.3" fill="var(--skrive-icon-doc-ink)" />
    </svg>
  );
}
