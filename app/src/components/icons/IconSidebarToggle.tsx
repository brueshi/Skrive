type Props = {
  size?: 16 | 24;
  shown?: boolean;
  className?: string;
};

export function IconSidebarToggle({
  size = 24,
  shown = true,
  className = ''
}: Props) {
  const fillClass = `rail-fill${shown ? '' : ' is-hidden'}`;
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
        <rect
          className={fillClass}
          x={2}
          y={3}
          width={4}
          height={10}
          fill="currentColor"
          stroke="none"
        />
        <line x1={6} y1={3} x2={6} y2={13} />
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
      <rect x={3} y={4} width={18} height={16} />
      <rect
        className={fillClass}
        x={3}
        y={4}
        width={6}
        height={16}
        fill="currentColor"
        stroke="none"
      />
      <line x1={9} y1={4} x2={9} y2={20} />
    </svg>
  );
}
