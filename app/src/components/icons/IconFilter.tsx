type Props = {
  size?: 16 | 24;
  className?: string;
};

// Funnel — the All list's folder/tag scope control. Wide mouth converging to
// a short stem, the conventional "filter / narrow this" affordance.
export function IconFilter({ size = 24, className = '' }: Props) {
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
        <path d="M2.5 3.75 H13.5 L9 8.75 V13 L7 14 V8.75 Z" />
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
      <path d="M4 5.5 H20 L13.5 12.75 V19 L10.5 20.5 V12.75 Z" />
    </svg>
  );
}
