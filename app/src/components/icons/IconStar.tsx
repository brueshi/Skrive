type Props = {
  size?: 16 | 24;
  /** Solid fill for the pinned state; outline when false. */
  filled?: boolean;
  className?: string;
};

const POINTS =
  '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 ' +
  '5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2';

export function IconStar({ size = 24, filled = false, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={size === 16 ? 1.25 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polygon points={POINTS} />
    </svg>
  );
}
