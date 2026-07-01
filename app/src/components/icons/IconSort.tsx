type Props = {
  size?: 16 | 24;
  className?: string;
};

// Descending bars — the conventional "sort" affordance. Three lines of
// decreasing length read as ordering without implying a direction.
export function IconSort({ size = 24, className = '' }: Props) {
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
        <line x1={3} y1={4} x2={13} y2={4} />
        <line x1={3} y1={8} x2={10} y2={8} />
        <line x1={3} y1={12} x2={7} y2={12} />
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
      <line x1={4} y1={6} x2={20} y2={6} />
      <line x1={4} y1={12} x2={15} y2={12} />
      <line x1={4} y1={18} x2={10} y2={18} />
    </svg>
  );
}
