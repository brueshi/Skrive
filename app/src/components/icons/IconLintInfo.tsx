// Lint panel toggle icon (used when no findings; switches to
// IconLintWarn / IconLintError when findings exist). A simple checkmark
// in a rounded square — implies "lint pass / clean state". Placeholder
// shape pending icon-roadmap pass.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconLintInfo({ size = 16, className = '' }: Props) {
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
        <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
        <path d="M7.5 12 L11 15.5 L16.5 9" />
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
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2" />
      <path d="M5 8 L7.25 10.25 L11 6.5" />
    </svg>
  );
}
