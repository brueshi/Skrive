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
  /** Heading indices to render, in document order — the fold-aware view of
   *  the list. Rows inside a collapsed section are absent, not hidden. */
  order: number[];
  /** Indices whose sections are collapsed. */
  folded: ReadonlySet<number>;
  /** Indices with nested headings under them, and so a twisty. */
  expandable: ReadonlySet<number>;
  /** Row carrying the highlight: the keyboard cursor, or the active
   *  section when the reader hasn't navigated with the keyboard. */
  selectedIndex: number;
  /** Section the reader is currently in; marked even when the keyboard
   *  cursor has moved elsewhere. Already resolved to a visible row by the
   *  rail, so scrolling into a collapsed section marks the fold head. */
  activeIndex: number;
  /** Stable DOM id for the row at `index`, referenced by the rail's
   *  `aria-activedescendant`. */
  optionId: (index: number) => string;
  onJump: (index: number) => void;
  onToggleFold: (index: number) => void;
  /** Positioning supplied by the rail (the clamped vertical `top`). */
  style?: CSSProperties;
};

export const OutlinePopover = forwardRef<HTMLDivElement, Props>(
  function OutlinePopover(
    {
      headings,
      order,
      folded,
      expandable,
      selectedIndex,
      activeIndex,
      optionId,
      onJump,
      onToggleFold,
      style
    },
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
        {order.map((i) => {
          const h = headings[i];
          if (!h) return null;
          const canFold = expandable.has(i);
          const isFolded = folded.has(i);
          return (
            <button
              type="button"
              key={h.key}
              id={optionId(i)}
              role="treeitem"
              aria-level={Math.min(h.depth, 6)}
              // Only a row with something under it has an expanded state;
              // on a leaf the attribute would claim a twisty that is not
              // there.
              aria-expanded={canFold ? !isFolded : undefined}
              aria-selected={i === selectedIndex}
              aria-current={i === activeIndex ? 'true' : undefined}
              className="outline-popover-row"
              data-depth={Math.min(h.depth, 6)}
              data-selected={i === selectedIndex || undefined}
              data-foldable={canFold || undefined}
              data-folded={isFolded || undefined}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              // One handler for the whole row, discriminating on where the
              // click landed. The twisty is a plain span rather than a
              // nested button: a treeitem must not contain its own
              // interactive descendants, and this also keeps the fold on a
              // real click event — WKWebView drops pointerup on a press
              // that never moves.
              onClick={(e) => {
                if (
                  canFold &&
                  (e.target as Element).closest('.outline-popover-twisty')
                ) {
                  onToggleFold(i);
                  return;
                }
                onJump(i);
              }}
              title={h.text}
            >
              <span className="outline-popover-twisty" aria-hidden="true" />
              <span className="outline-popover-label">{h.text || '—'}</span>
            </button>
          );
        })}
      </motion.div>
    );
  }
);
