// Inbox tray — heads the sidebar's Inbox strip (unfiled root documents).
// Part of the scalable icon overhaul (SKR-243); drawn on its own grid.
// Colour inherited via currentColor.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconInbox({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 116.5 114"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.359}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeMiterlimit={10}
      className={className}
      aria-hidden="true"
    >
      <path d="M25.1 62.843L39.2 62.843C41 62.843 43 63.945 44.4 67.554C45.5 70.36 47.1 73.066 50.5 73.065L66 73.065C68.9 73.065 70.8 71.361 71.7 68.957C72.6 66.553 73.9 62.944 76.9 62.843C79.7 62.643 88.6 62.843 91.8 62.843M38.682 33.448L77.6 33.58C80 33.58 81.6 34.582 82.6 36.587L92 63.044L92 83.989C92 86.695 89.6 89.1 86.9 89.1L30.3 89.1C27.5 89.1 24.6 86.995 24.6 83.688L24.6 62.843L34.8 36.687C35.8 34.783 37.2 33.58 39 33.58L78.046 33.676" />
    </svg>
  );
}
