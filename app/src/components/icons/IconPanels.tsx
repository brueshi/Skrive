// Generic "panels" affordance — three stacked horizontal sections,
// suggesting a grouped menu of panel toggles. Used by the collapsed
// topbar variant where FM/Backlinks/History are folded into a single
// popover trigger.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconPanels({ size = 16, className = '' }: Props) {
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
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M2.5 6.25 L13.5 6.25" />
        <path d="M2.5 10 L13.5 10" />
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
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 9 L20.5 9" />
      <path d="M3.5 15 L20.5 15" />
    </svg>
  );
}
