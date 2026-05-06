type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconDotUnsaved({ size = 24, className = '' }: Props) {
  if (size === 16) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="currentColor"
        className={className}
        aria-hidden="true"
      >
        <circle cx={8} cy={8} r={2.25} />
      </svg>
    );
  }
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <circle cx={12} cy={12} r={3} />
    </svg>
  );
}
