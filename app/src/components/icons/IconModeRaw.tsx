// Markdown source-mode "raw" icon (SKR-197): a document showing raw Markdown
// with the "M↓" glyph. Recoloured onto Skrive's muted, theme-adaptive filled-icon
// tokens (the same set IconDocMarkdown uses) so it sits calm in the chrome.

type Props = {
  size?: number;
  className?: string;
};

export function IconModeRaw({ size = 22, className = '' }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <path
        d="m107 31.3-23.7-23.5c-0.7-0.8-2.2-1.2-3.3-1.2h-49c-4.9 0-9 4-9 9v97.4c0 4.9 4.1 9.4 9 9.4h68.8c4.9 0 9.2-4.4 9.2-9.4v-78.3c0-1.1-1.2-2.5-2-3.4z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m104.9 30.5-23.5-23c-0.9-1.1-2.8-1.6-4.4-1.6h-48.6c-4.4 0-9.4 3.9-9.4 9.1v95.9c-0.3 5.3 4 8.7 8.9 8.7h69.2c5 0 9.4-3.4 9.4-8.8v-76.7c0-1.1-0.6-2.7-1.6-3.6z"
        fill="var(--skrive-icon-doc-ink)"
      />
      <path
        d="m96.7 115.7h-67.9c-2.8 0-5.4-2.1-5.4-5.3v-95.5c0-2.7 2.4-5 5.2-5h47.9v17.1c0 4.3 3.5 7.7 7.8 7.7h17.6v75.8c0 2.7-2.1 5.2-5.2 5.2z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m80.8 12.7v13.9c0 2.1 1.5 4 3.6 4h14.5l-18.1-17.9z"
        fill="var(--skrive-icon-doc-edge)"
      />
      <path
        d="m23.4 13.9v0.1c0.8-2.4 2.7-4.1 5.2-4.1h48l-0.1-0.1-47.5-0.1c-2.6-0.1-5 1.6-5.6 4.2z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m96.9 115.5h-68.3c-2 0-4.1-1.5-4.8-3.2 0.8 2.2 2.7 3.4 4.9 3.4h68c2.7 0 5.2-1.3 5.2-4.2s-0.1-76.8-0.1-76.8l-0.3 0.2 0.2 75.7c0 2.6-2.2 4.9-4.8 4.9z"
        fill="var(--skrive-icon-doc-page)"
      />
      <path
        d="m86.8 76.3h-47.7c-1.6 0-2.3-0.9-2.4-1.9-0.2-1.4 0.9-2.3 2.1-2.3h48c1.1 0 2 0.9 2 2.1s-0.8 2.1-2 2.1z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m52.5 84.9h-13.7c-0.8 0-2.1-0.6-2.1-1.7v-0.7c0-1 0.9-1.9 1.9-1.9h13.9c1.1 0 2 0.7 2 2v0.7c0 0.8-1.1 1.6-2 1.6z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m76.7 84.9h-16.2c-1.1 0-2-0.6-2-1.6v-0.9c0-1 0.9-1.8 2-1.8h16.1c1.1 0 2.1 0.7 2.1 1.7v0.8c0 1-0.9 1.8-2 1.8z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m68.4 94.2h-29.7c-0.9 0-2-0.7-2-1.8v-0.5c0-0.9 0.9-1.9 1.8-1.9h30.1c1 0 1.9 0.7 1.9 1.6v1c-0.1 0.9-0.9 1.6-2.1 1.6z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m86.8 94.2h-10.4c-1 0-1.9-0.7-1.9-1.6v-0.9c0-0.9 0.9-1.7 1.8-1.7h10.5c1.1 0 2 0.7 2 1.9v0.6c0 1-1.1 1.7-2 1.7z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m66.7 103h-27.9c-1 0-2.1-0.8-2.1-1.9v-0.3c0-1 0.9-2 1.9-2h28.2c1.1 0 2.1 0.7 2.1 1.9v0.3c0 1.1-1 2-2.2 2z"
        fill="var(--skrive-icon-doc-faint)"
      />
      <path
        d="m64.5 41.3h-5.1l-7.8 9.7-7.4-9.5-0.6-0.2h-5.7c-0.5 0.2-1.1 0.9-1.1 1.6v20.9c0 0.7 0.6 1.3 1.2 1.4h4.5c0.7 0 1.5-0.7 1.5-1.4v-12.5l6.6 7.9 2 0.1 6.4-8v12.3c0 1 0.6 1.5 1.4 1.5l4.3-0.1c0.6 0 1.1-0.6 1.1-1.4v-20.7c-0.3-0.9-0.8-1.5-1.3-1.6z"
        fill="var(--skrive-accent)"
      />
      <path
        d="m82.6 54.1v-11.5c-0.2-0.8-0.7-1.3-1.2-1.3h-4.4c-0.5-0.1-1.1 0.5-1.2 1.2v11.6h-5.1c-0.9 0.1-1.3 1.4-0.6 2l8.5 9.2c0.3 0.3 1 0.2 1.4-0.2l8.6-9.3c0.7-0.7 0.3-1.8-0.5-1.8l-5.5 0.1z"
        fill="var(--skrive-accent)"
      />
    </svg>
  );
}
