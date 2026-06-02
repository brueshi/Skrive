type Props = {
  size?: 16 | 24;
  shown?: boolean;
  className?: string;
};

// Sidebar show/hide toggle. A rounded panel with a filled left rail; the
// rail collapses to the left (rail-fill / is-hidden, animated in CSS)
// when the sidebar is hidden, so the glyph mirrors the actual state.
// The rail is a path with only its left corners rounded so it reads as
// filling the compartment up to the divider rather than a floating pill.
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
        <rect x={2} y={3} width={12} height={10} rx={2.5} />
        <path
          className={fillClass}
          d="M6 3 L4.5 3 Q2 3 2 5.5 L2 10.5 Q2 13 4.5 13 L6 13 Z"
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
      <rect x={3} y={4} width={18} height={16} rx={3.5} />
      <path
        className={fillClass}
        d="M9 4 L6.5 4 Q3 4 3 7.5 L3 16.5 Q3 20 6.5 20 L9 20 Z"
        fill="currentColor"
        stroke="none"
      />
      <line x1={9} y1={4} x2={9} y2={20} />
    </svg>
  );
}
