// Pushpin — the desk's pin affordance and pinned-row marker. Part of the
// scalable icon overhaul (SKR-243): drawn on its own grid rather than the
// legacy 24×24 set. Colour is inherited (currentColor) so the row conveys
// pinnable-vs-pinned through opacity/tint, not two glyphs.
//
// The viewBox is cropped to the glyph's stroke-inclusive bounds (measured
// bbox 38.6,21.9 38.7x70.2, padded to a centred square) — the source art
// left ~two-thirds of its box empty, which rendered the pin tiny in the
// row slot.

type Props = {
  size?: 16 | 24;
  className?: string;
};

export function IconPin({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="14 13 88 88"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.369}
      strokeLinecap="square"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m73.5 27.9c0-2.9-5.4-5.9-15.5-6s-15.7 2.3-15.8 5.8c-0.1 3.4 5.8 5.7 15.7 5.7 9.3 0 15.6-2.6 15.6-5.5zm-26.4 4.4-1 18.9c-3.4 0.8-7.5 4.2-7.5 8.7 0 1 0.7 2.3 2.3 2.3h34.1c1.4 0.1 2.3-1.1 2.3-2.3-0.1-4-3-7.7-7.1-9.1l-1.4-18.1m-10.9 29.6v29.8" />
    </svg>
  );
}
