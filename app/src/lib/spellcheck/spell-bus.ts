// The invalidation channel between the surface and the spellcheck controller:
// "this block's text changed" (`invalidate(id)`) or "a structural pass rebuilt
// the tree" (`invalidate(null)`). The surface owns one and pokes it from the
// same two hooks the decoration overlay rides; the controller subscribes and
// re-checks on its own debounce, so nothing here does work on the keystroke
// path beyond a null check and a Set insert.
//
// This mirrors HighlightBus, which does the same job for code blocks. Two
// near-identical buses is the deliberate cost of not refactoring a shipped
// class inside a feature commit; a third consumer is the signal to extract one.

/** `ids` is the block ids whose text changed, or `null` to reassess everything
 *  (a reconcile may have added, removed or rebuilt blocks). */
type Listener = (ids: readonly string[] | null) => void;

export class SpellBus {
  private listener: Listener | null = null;

  /** Register the controller. One listener per bus (one controller per surface).
   *  Returns an unsubscribe the controller calls on destroy. */
  subscribe(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Signal a changed block (`blockId`) or a full reassess (`null`). A no-op
   *  when nothing is subscribed — which is the case for every host without a
   *  spelling oracle, and whenever the writer has spellcheck switched off. */
  invalidate(blockId: string | null): void {
    if (!this.listener) return;
    this.listener(blockId === null ? null : [blockId]);
  }
}
