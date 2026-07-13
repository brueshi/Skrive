type Props = {
  size?: 16 | 24;
  className?: string;
};

// Magnifier — the sidebar's quick-open (Search) affordance. Line lens + handle.
export function IconSearch({ size = 24, className = '' }: Props) {
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
        <circle cx={7} cy={7} r={4.25} />
        <line x1={10.2} y1={10.2} x2={13.5} y2={13.5} />
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
      <circle cx={10.5} cy={10.5} r={6.5} />
      <line x1={15.5} y1={15.5} x2={20.5} y2={20.5} />
    </svg>
  );
}
