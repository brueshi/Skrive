type Props = {
  size?: 16 | 24;
  open?: boolean;
  className?: string;
};

// Filled, multi-tone folder (paper.design). Unlike the old line glyph, open and
// closed are two distinct drawings, so the `open` prop crossfades between them
// rather than morphing a pocket line. Both states are stacked and bottom-aligned
// so the lift reads as the lid opening upward. Tones resolve from the
// --skrive-icon-folder-* tokens, which are tuned per theme (see index.css).
export function IconFolder({ size = 24, open = false, className = '' }: Props) {
  return (
    <span
      className={`icon-folder${className ? ` ${className}` : ''}`}
      data-open={open || undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        className="icon-folder__closed"
        viewBox="0 0 114.7 85"
        fill="none"
      >
        <path
          d="m95 4h-78c-2.6 0-5.3 2.7-5.3 5.3v62.7h88.8l0.1-62.4c0-3-2.6-5.6-5.6-5.6z"
          fill="var(--skrive-icon-folder-back)"
        />
        <path
          d="m103.6 12.3h-28.1c-3 0-5.8 2.4-5.9 5.4v4.4h-40.7c-3.2 0-5.8 2.1-6.6 5.3l-10.4 44.6 89-0.1 8.7-52.9c0.4-3.6-2.3-6.5-6-6.7z"
          fill="var(--skrive-icon-folder-front)"
        />
        <path
          d="m103.9 81h-95.3c-2.1 0-3.8-2-3.8-4.3 0-2.4 1.8-4.7 3.9-4.7h95.2c2.6 0 4.2 2 4.2 4.4s-2.1 4.6-4.2 4.6z"
          fill="var(--skrive-icon-folder-lip)"
        />
      </svg>
      <svg className="icon-folder__open" viewBox="0 0 64 64" fill="none">
        <path
          d="m52.5 15.3h-42.6c-1.6-0.2-3 1.4-3.1 2.7v35l10.7-0.1-0.1-27.9v-9.7h-0.1z"
          fill="var(--skrive-icon-folder-back)"
        />
        <path
          d="m48.6 15.3v5.7h7.4v-2.7c0-1.6-1.5-3.1-3.5-3z"
          fill="var(--skrive-icon-folder-back)"
        />
        <path
          d="m45.3 5.5h-24.6c-1.6 0-3.3 1.5-3.3 3.2v17.3h31.3v-17.2c0-1.7-1.4-3.3-3.4-3.3z"
          fill="var(--skrive-icon-folder-paper)"
        />
        <path
          d="m58.1 19.8h-15.9c-1.7 0-3.3 1.5-3.2 3.2v2.3h-23c-1.3 0.1-3 0.9-3.5 3.1l-5.6 24.6 49.4 0.4 4.8-29.4c0.3-2.3-1.1-4-3-4.2z"
          fill="var(--skrive-icon-folder-front)"
        />
        <path
          d="m6.9 53h-1.8c-1.1 0-2.3 1.1-2.3 2.7-0.1 1.2 1.1 2.5 2.4 2.5h52.8c1 0 2.2-1.2 2.2-2.3v-0.5c0-1.2-1-2.3-2.3-2.4h-51z"
          fill="var(--skrive-icon-folder-lip)"
        />
        <path
          d="m6 53.1h-1c-0.9 0.1-1.8 1.1-1.9 2.2l-0.1 0.8c0 1.1 1.1 2 2.1 2l52.8-0.1c0.9 0 2-0.8 2.1-1.8l0.1-0.5c0.2-1.1-0.9-2.6-2.2-2.5l-51.9-0.1z"
          fill="var(--skrive-icon-folder-lip)"
        />
      </svg>
    </span>
  );
}
