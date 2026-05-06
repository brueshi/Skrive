type Props = {
  size?: 16 | 24;
  open?: boolean;
  className?: string;
};

// Pocket lines normalized to 3 points so CSS `d` transition interpolates smoothly.
function pocketPath(size: 16 | 24, open: boolean): string {
  if (size === 16) {
    return open ? 'M 2 8 L 8 8 L 14 5.5' : 'M 2 7.5 L 8 7.5 L 14 7.5';
  }
  return open ? 'M 3 12 L 16 12 L 21 8' : 'M 3 11 L 16 11 L 21 11';
}

export function IconFolder({
  size = 24,
  open = false,
  className = ''
}: Props) {
  const d = pocketPath(size, open);
  if (size === 16) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        <path d="M2 3.5 L7 3.5 L8.75 5.5 L14 5.5 L14 13.5 L2 13.5 Z" />
        <path
          className="pocket-line"
          d={d}
          style={{ d: `path("${d}")` } as React.CSSProperties}
        />
      </svg>
    );
  }
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 5 L10 5 L12.5 8 L21 8 L21 20 L3 20 Z" />
      <path
        className="pocket-line"
        d={d}
        style={{ d: `path("${d}")` } as React.CSSProperties}
      />
    </svg>
  );
}
