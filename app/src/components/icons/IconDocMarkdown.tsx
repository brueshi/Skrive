type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconDocMarkdown({ size = 24, className = '' }: Props) {
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
        <path d="M3.5 2 L9 2 L13 6 L13 14 L3.5 14 Z" />
        <path d="M9 2 L9 6 L13 6" />
        <path d="M7 9 L7 12.5" strokeWidth={0.875} />
        <path d="M9 9 L9 12.5" strokeWidth={0.875} />
        <path d="M5.75 9.75 L10.25 9.75" strokeWidth={0.875} />
        <path d="M5.75 11.5 L10.25 11.5" strokeWidth={0.875} />
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
      <path d="M5 3 L13 3 L19 8 L19 21 L5 21 Z" />
      <path d="M13 3 L13 8 L19 8" />
      <path d="M10.5 13.5 L10.5 18.75" strokeWidth={1.25} />
      <path d="M13.5 13.5 L13.5 18.75" strokeWidth={1.25} />
      <path d="M8.625 14.625 L15.375 14.625" strokeWidth={1.25} />
      <path d="M8.625 17.25 L15.375 17.25" strokeWidth={1.25} />
    </svg>
  );
}
