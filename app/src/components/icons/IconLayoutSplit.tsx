type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconLayoutSplit({ size = 24, className = '' }: Props) {
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
        <rect x={2} y={3} width={12} height={10} />
        <line x1={8} y1={3} x2={8} y2={13} />
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
      <rect x={3} y={5} width={18} height={14} />
      <line x1={12} y1={5} x2={12} y2={19} />
    </svg>
  );
}
