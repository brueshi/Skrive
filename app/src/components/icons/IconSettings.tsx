type Props = {
  size?: 16 | 24;
  className?: string;
};

// Sliders — the utility bar's Settings affordance. Two tracks, each broken by
// a knob at a different offset (the "adjustments" idiom, matching the mock's
// choice over a gear).
export function IconSettings({ size = 24, className = '' }: Props) {
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
        <line x1={2.5} y1={6} x2={8} y2={6} />
        <line x1={12} y1={6} x2={13.5} y2={6} />
        <circle cx={10} cy={6} r={1.7} />
        <line x1={2.5} y1={10.5} x2={5} y2={10.5} />
        <line x1={9} y1={10.5} x2={13.5} y2={10.5} />
        <circle cx={7} cy={10.5} r={1.7} />
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
      <line x1={4} y1={8} x2={12} y2={8} />
      <line x1={18} y1={8} x2={20} y2={8} />
      <circle cx={15} cy={8} r={2.5} />
      <line x1={4} y1={16} x2={8} y2={16} />
      <line x1={14} y1={16} x2={20} y2={16} />
      <circle cx={11} cy={16} r={2.5} />
    </svg>
  );
}
