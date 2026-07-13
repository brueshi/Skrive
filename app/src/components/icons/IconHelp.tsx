type Props = {
  size?: 16 | 24;
  className?: string;
};

// Question mark in a ring — the utility bar's Help affordance. The dot is a
// zero-length round-capped stroke (renders as a filled point at any size).
export function IconHelp({ size = 24, className = '' }: Props) {
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
        <circle cx={8} cy={8} r={6} />
        <path d="M6.3 6.4a1.85 1.85 0 0 1 3.55 0.65c0 1.25-1.85 1.6-1.85 2.55" />
        <path d="M8 11.65h0.01" />
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
      <circle cx={12} cy={12} r={9} />
      <path d="M9.2 9.4a2.9 2.9 0 0 1 5.6 1c0 1.95-2.8 2.6-2.8 3.9" />
      <path d="M12 17.5h0.01" />
    </svg>
  );
}
