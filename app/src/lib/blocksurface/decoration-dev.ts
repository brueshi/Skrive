// Dev-only exercise harness for the decoration overlay. The overlay is a
// foundation whose real consumers (find/replace, spellcheck) don't exist yet, so
// nothing adds a decoration in normal use. This installs a small
// console hook — `window.__skrive.decorate('word')` — that seeds decorations over
// every occurrence of a query, so the overlay can be verified in the real shell.
//
// Only mounted in dev builds (see BlockEditor). It reads offsets from each block
// element's textContent, which equals the flat offset space for prose and inline
// tags but not for image/hard-break atoms — good enough to exercise the layer, and
// deliberately NOT the path any shipping feature takes (those compute offsets from
// the block model). It is a smoke tool, not API surface.

import { BLOCK_ID_ATTR } from './render';
import type { Decoration, DecorationStore, DecorationType } from './decorations';

export type DecorationDevApi = {
  /** The live store, for ad-hoc `setType` / `clear` from the console. */
  readonly store: DecorationStore;
  /** Decorate every occurrence of `query` across leaf blocks; returns the count.
   *  An empty query clears the type. */
  decorate(query: string, type?: DecorationType): number;
  /** Clear one type, or everything when called with no argument. */
  clear(type?: DecorationType): void;
};

/** Install the `window.__skrive` decoration harness for a surface's store, scanning
 *  block text under `host`. Returns a teardown that removes the global. */
export function installDecorationDevHarness(host: HTMLElement, store: DecorationStore): () => void {
  const decorate = (query: string, type: DecorationType = 'find-match'): number => {
    if (query.length === 0) {
      store.clearType(type);
      return 0;
    }
    const decs: Decoration[] = [];
    for (const el of host.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`)) {
      // Leaf blocks only — a container (list / blockquote) has no flat offset space
      // of its own; its child paragraphs carry the ids and the text.
      if (el.querySelector(`[${BLOCK_ID_ATTR}]`)) continue;
      const blockId = el.getAttribute(BLOCK_ID_ATTR);
      if (!blockId) continue;
      const text = el.textContent ?? '';
      let i = text.indexOf(query);
      while (i !== -1) {
        decs.push({ blockId, start: i, end: i + query.length, type });
        i = text.indexOf(query, i + query.length);
      }
    }
    store.setType(type, decs);
    return decs.length;
  };

  const api: DecorationDevApi = {
    store,
    decorate,
    clear: (type) => (type ? store.clearType(type) : store.clear())
  };

  (window as unknown as { __skrive?: DecorationDevApi }).__skrive = api;
  return () => {
    const w = window as unknown as { __skrive?: DecorationDevApi };
    if (w.__skrive === api) delete w.__skrive;
  };
}
