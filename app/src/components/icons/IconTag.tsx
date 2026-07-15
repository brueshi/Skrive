type Props = {
  size?: 16 | 24;
  className?: string;
};

// The tag glyph — the sidebar's Tags facet and the active-tag chip. The same
// drawing the inline `#tag` chip wears, so the affordance reads consistently from
// the editor to the sidebar. Filled, resolves to currentColor.
export function IconTag({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 116.4 115"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="m90.9 23.8c-1.8-1.6-4.6-2.8-7.4-2.5l-18.5 1.6c-2.1 0.2-4.4 1.1-6.1 2.7l-34.6 34.6c-1.3 1.3-2.2 3.4-2.2 5.5 0.2 1.6 0.8 3.6 2.2 5l20.6 20.2c1.5 1.6 3.6 2.4 5.7 2.5 1.8 0 3.9-0.5 5.4-1.8l33.6-33.6c1.6-1.6 2.8-3.6 3-6.6l1.4-18.6c0.1-3.5-1.2-7.1-3.1-9zm-4.3 28.9-34.6 34.3c-0.7 0.8-2.4 0.7-3.3-0.1l-19.8-20.1c-0.8-0.7-0.8-1.9 0.1-2.7l34.3-34.5c0.5-0.4 1-0.8 1.7-0.8l18.6-1.7c1.2-0.1 2.3 0 3.1 0.7 1.1 1 1.8 2 1.6 3.6l-1.8 19.4c0.1 0.7 0.1 1.4 0.1 1.9z" />
      <path d="m74.7 31.6c-4.8 0-9.2 4-9.2 8.8s3.7 9.9 9.2 9.9c4.8 0.1 9.1-3.9 9.1-8.7 0.4-4.9-3.8-10-9.1-10zm0 12.8c-1.5 0-3.2-1.4-3.3-3.5 0-1.8 1.5-3.8 3.5-3.8 1.5 0 3.1 1.4 3.1 3.5 0 2.2-2 3.8-3.3 3.8z" />
    </svg>
  );
}
