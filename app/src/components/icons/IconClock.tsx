type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconClock({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={size === 16 ? 1.25 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx={12} cy={12} r={9} />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}
