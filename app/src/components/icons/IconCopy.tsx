type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconCopy({ size = 24, className = '' }: Props) {
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
        <rect x={5.5} y={5.5} width={8} height={8} rx={1.5} />
        <path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6" />
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
      <rect x={8} y={8} width={12} height={12} rx={2} />
      <path d="M5 15.5v-9a1.5 1.5 0 0 1 1.5-1.5h9" />
    </svg>
  );
}
