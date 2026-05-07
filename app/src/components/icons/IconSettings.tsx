// Settings/preferences gear icon. Placeholder geometry pending the
// icon-roadmap pass; matches the existing icon set's stroke-weight +
// 16/24 sizes.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconSettings({ size = 16, className = '' }: Props) {
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
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3 V5.5 M12 18.5 V21 M3 12 H5.5 M18.5 12 H21 M5.6 5.6 L7.4 7.4 M16.6 16.6 L18.4 18.4 M5.6 18.4 L7.4 16.6 M16.6 7.4 L18.4 5.6" />
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
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2 V3.5 M8 12.5 V14 M2 8 H3.5 M12.5 8 H14 M3.7 3.7 L4.8 4.8 M11.2 11.2 L12.3 12.3 M3.7 12.3 L4.8 11.2 M11.2 4.8 L12.3 3.7" />
    </svg>
  );
}
