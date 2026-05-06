type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconLayoutPreview({ size = 24, className = '' }: Props) {
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
        <line x1={4.5} y1={6.5} x2={11.5} y2={6.5} />
        <line x1={4.5} y1={8.5} x2={11.5} y2={8.5} />
        <line x1={4.5} y1={10.5} x2={9} y2={10.5} />
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
      <rect x={3} y={5} width={18} height={14} />
      <line x1={6.5} y1={9.5} x2={17.5} y2={9.5} />
      <line x1={6.5} y1={12} x2={17.5} y2={12} />
      <line x1={6.5} y1={14.5} x2={13.5} y2={14.5} />
    </svg>
  );
}
