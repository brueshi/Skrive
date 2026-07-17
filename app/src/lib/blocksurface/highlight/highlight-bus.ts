// The invalidation channel between the surface and the code-highlight painter —
// the highlight analogue of DecorationStore's invalidate/subscribe, minus the
// range storage (highlight tokens come from the worker, not a consumer, so there
// is nothing to hold here). The surface owns one and pokes it when a code block's
// text changes (`invalidate(id)`) or a structural pass rebuilt the tree
// (`invalidate(null)`); the painter subscribes and repaints.
//
// The surface gates per-block invalidations to code blocks at the call site, so a
// prose keystroke never reaches this bus at all.

/** `ids` is the block ids to re-highlight, or `null` to reassess every code block
 *  (a reconcile may have rebuilt or removed elements). */
type Listener = (ids: readonly string[] | null) => void;

export class HighlightBus {
  private listener: Listener | null = null;

  /** Register the painter. One listener per bus (one painter per surface).
   *  Returns an unsubscribe the painter calls on destroy. */
  subscribe(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Signal that a code block changed (`blockId`) or that a structural pass needs a
   *  full reassess (`null`). A no-op when nothing is subscribed. */
  invalidate(blockId: string | null): void {
    if (!this.listener) return;
    this.listener(blockId === null ? null : [blockId]);
  }
}
