// Focus mode's active-block marker. Paints `.is-focus-active` on the top-level
// block holding the caret so the CSS in BlockEditor.css can dim every other one.
// View-only: it never touches the model, the caret, or the editable DOM's content.
//
// Attached only while focus mode is on (BlockEditor gates it, the way the live
// word counts are gated on their badge), so the mode costs literally nothing when
// off — there is no listener to run.
//
// Two signals, neither on the keystroke hot path:
//   - `document` selectionchange, rAF-coalesced. The surface's own
//     onSelectionChange is a single slot already owned by the menu controller, and
//     this needs no formatting summary — just the caret's block — so it listens
//     directly, the way the word-count badge does.
//   - the surface's structural-change signal, because a reconcile replaces block
//     elements outright and the class dies with the element it was painted on.
//
// TOP-LEVEL blocks only, deliberately: opacity compounds, so a dimmed list could
// never host an undimmed item. A caret anywhere inside a list keeps the whole list
// lit, which reads correctly — a list is one thought. Finer (sentence / line)
// granularity is a separate, opt-in behavior.

import type { BlockSurface } from './surface';
import { BLOCK_ID_ATTR } from './render';

export type FocusActiveHandle = { destroy(): void };

const ACTIVE_CLASS = 'is-focus-active';

type Options = {
  /** The surface host element — top-level blocks are its element children. */
  surface: HTMLElement;
  /** The live surface, for its structural re-render signal. */
  blockSurface: BlockSurface;
};

/** The top-level block element containing `node`, or null when the node is
 *  outside the surface. Walks to the block element nearest the node, then up to
 *  the child of the host — nested leaves (list items, quote paragraphs) resolve
 *  to the container that actually gets dimmed. */
function topLevelBlockOf(surface: HTMLElement, node: Node | null): HTMLElement | null {
  const start = node instanceof Element ? node : node?.parentElement;
  if (!start || !surface.contains(start)) return null;
  let el: HTMLElement | null = start.closest<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
  while (el && el.parentElement !== surface) {
    el = el.parentElement;
  }
  return el;
}

export function attachFocusActive({ surface, blockSurface }: Options): FocusActiveHandle {
  let painted: HTMLElement | null = null;
  let scheduled = false;

  const paint = (): void => {
    const sel = window.getSelection();
    // focusNode, not anchorNode: it is the moving end of a selection, so it
    // tracks where the writer actually is.
    const next = sel && sel.rangeCount > 0 ? topLevelBlockOf(surface, sel.focusNode) : null;
    // A reconcile can hand back a fresh element for the same block, so identity —
    // not the block id — is what decides whether a repaint is needed. `painted`
    // may also have been detached entirely, in which case its class went with it.
    if (next === painted && (next === null || next.classList.contains(ACTIVE_CLASS))) return;
    if (painted && painted !== next) painted.classList.remove(ACTIVE_CLASS);
    next?.classList.add(ACTIVE_CLASS);
    painted = next;
  };

  // Coalesce to one paint per frame: selectionchange storms during a drag-select
  // or a held arrow key, and the class only needs to be right by the next paint.
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      paint();
    });
  };

  document.addEventListener('selectionchange', schedule);
  const unsubscribeStructure = blockSurface.onStructureChange(schedule);
  // Paint immediately so entering the mode mid-document lights the caret's block
  // rather than waiting for the writer to move.
  paint();

  return {
    destroy(): void {
      document.removeEventListener('selectionchange', schedule);
      unsubscribeStructure();
      painted?.classList.remove(ACTIVE_CLASS);
      painted = null;
    }
  };
}
