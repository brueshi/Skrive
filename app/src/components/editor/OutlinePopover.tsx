// The labeled outline card that expands from the rail on hover or focus
// (Image #2). Purely presentational: the rail owns open/selection state,
// keyboard handling, and vertical placement, so this just renders the
// heading list and reports row clicks. Rows are the `option`s of the
// rail's listbox, so the rail's `aria-activedescendant` can point at the
// selected one. The rail measures this card (via the forwarded ref) to
// position it, and passes the resulting `top` through `style`.

import { motion, useReducedMotion } from 'framer-motion';
import { forwardRef } from 'react';
import type { CSSProperties } from 'react';
import type { OutlineHeading } from '../../lib/preview/outline';

type Props = {
  headings: OutlineHeading[];
  /** Row carrying the highlight: the keyboard cursor, or the active
   *  section when the reader hasn't navigated with the keyboard. */
  selectedIndex: number;
  /** Section the reader is currently in; marked even when the keyboard
   *  cursor has moved elsewhere. */
  activeIndex: number;
  /** Stable DOM id for the option at `index`, referenced by the rail's
   *  `aria-activedescendant`. */
  optionId: (index: number) => string;
  onJump: (index: number) => void;
  /** Positioning supplied by the rail (the clamped vertical `top`). */
  style?: CSSProperties;
};

export const OutlinePopover = forwardRef<HTMLDivElement, Props>(
  function OutlinePopover(
    { headings, selectedIndex, activeIndex, optionId, onJump, style },
    ref
  ) {
    const reduced = useReducedMotion();
    return (
      <motion.div
        ref={ref}
        className="outline-popover"
        role="presentation"
        style={style}
        initial={reduced ? false : { opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, x: 6 }}
        transition={
          reduced ? { duration: 0 } : { duration: 0.14, ease: [0.16, 1, 0.3, 1] }
        }
      >
        {headings.map((h, i) => (
          <button
            type="button"
            key={h.key}
            id={optionId(i)}
            role="option"
            aria-selected={i === selectedIndex}
            aria-current={i === activeIndex ? 'true' : undefined}
            className="outline-popover-row"
            data-depth={Math.min(h.depth, 6)}
            data-selected={i === selectedIndex || undefined}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onJump(i)}
            title={h.text}
          >
            {h.text || '—'}
          </button>
        ))}
      </motion.div>
    );
  }
);
