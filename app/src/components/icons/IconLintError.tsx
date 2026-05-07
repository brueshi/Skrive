// Lint error icon — an octagon with an exclamation. Placeholder shape
// pending the icon-roadmap lint family pass.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconLintError({ size = 16, className = '' }: Props) {
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
        <path d="M8 3 H16 L21 8 V16 L16 21 H8 L3 16 V8 Z" />
        <path d="M12 8 L12 13" />
        <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none" />
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
      <path d="M5.5 2 H10.5 L14 5.5 V10.5 L10.5 14 H5.5 L2 10.5 V5.5 Z" />
      <path d="M8 5.5 L8 9" />
      <circle cx="8" cy="10.75" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
