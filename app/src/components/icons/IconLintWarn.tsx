// Lint warning icon — a triangle with an exclamation. Placeholder
// shape pending the icon-roadmap pass that will replace the lint
// family with designed variants.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconLintWarn({ size = 16, className = '' }: Props) {
  if (size === 24) {
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
        <path d="M12 4 L21 19 L3 19 Z" />
        <path d="M12 10 L12 14" />
        <circle cx="12" cy="16.5" r="0.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
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
      <path d="M8 2.5 L14 13 L2 13 Z" />
      <path d="M8 6.5 L8 9.5" />
      <circle cx="8" cy="11" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
