type Props = {
  size?: 16 | 24;
  className?: string;
};

// List view — bulleted rows, the "flat list" half of the All view toggle.
// Paired with IconFolder (the folder-tree half).
export function IconList({ size = 24, className = '' }: Props) {
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
        <circle cx={3} cy={4} r={1} fill="currentColor" stroke="none" />
        <circle cx={3} cy={8} r={1} fill="currentColor" stroke="none" />
        <circle cx={3} cy={12} r={1} fill="currentColor" stroke="none" />
        <line x1={6} y1={4} x2={13.5} y2={4} />
        <line x1={6} y1={8} x2={13.5} y2={8} />
        <line x1={6} y1={12} x2={13.5} y2={12} />
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
      <circle cx={4.5} cy={6} r={1.2} fill="currentColor" stroke="none" />
      <circle cx={4.5} cy={12} r={1.2} fill="currentColor" stroke="none" />
      <circle cx={4.5} cy={18} r={1.2} fill="currentColor" stroke="none" />
      <line x1={9} y1={6} x2={20} y2={6} />
      <line x1={9} y1={12} x2={20} y2={12} />
      <line x1={9} y1={18} x2={20} y2={18} />
    </svg>
  );
}
