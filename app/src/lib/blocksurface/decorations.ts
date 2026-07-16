// Block-keyed decoration store: the pure data half of the surface's decoration
// overlay. Decorations are view-only annotations painted OVER live editable text
// (find-match highlights, spelling squiggles) — they never touch the model, the
// editable DOM, or the caret. The store holds no DOM: it is a set of ranges keyed
// by block id, in the same flat offset space as inline-ops.ts, and a single
// invalidation channel the overlay subscribes to.
//
// The surface owns one store (`surface.decorations`) and drives its invalidation
// from the same re-render hooks the caret rides: a block's DOM is rebuilt on every
// edit (renderInlineInto wipes it), so a decoration on that block must recompute
// its geometry afterward. That recompute is the overlay's job; the store's only
// keystroke-path cost is a Map lookup to decide whether the edited block carries a
// decoration at all — O(1), and free when no feature has painted anything.

/** The decoration kinds the overlay styles distinctly. Extend the union (and the
 *  companion CSS) as consumers need more; the store itself is kind-agnostic. */
export type DecorationType = 'find-match' | 'misspelling';

/** A single decoration: a flat half-open range `[start, end)` within one block,
 *  in inline-ops.ts offset space (atoms count as one, matching the selection map).
 *  `end <= start` is a no-op — the overlay paints nothing for an empty range. */
export type Decoration = {
  blockId: string;
  start: number;
  end: number;
  type: DecorationType;
};

/** The overlay's subscription callback. `dirty` is the block ids whose decorations
 *  changed (data edit or re-render), or `null` to reassess every decorated block
 *  (a reflow / structural reconcile moved geometry or removed a block). */
type Listener = (dirty: readonly string[] | null) => void;

const EMPTY: readonly Decoration[] = Object.freeze([]);

export class DecorationStore {
  private readonly byBlock = new Map<string, Decoration[]>();
  private listener: Listener | null = null;

  /** Register the overlay. One listener per store (one overlay per surface).
   *  Returns an unsubscribe the overlay calls on destroy. */
  subscribe(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Every decoration on a block, or an empty array. The overlay reads this to
   *  paint one block's boxes; the returned array must not be mutated. */
  forBlock(blockId: string): readonly Decoration[] {
    return this.byBlock.get(blockId) ?? EMPTY;
  }

  /** The block ids that currently carry any decoration. The overlay iterates these
   *  on a full reassess (so a decorated-but-unpainted block gets a chance to paint
   *  once its element exists). */
  blockIds(): Iterable<string> {
    return this.byBlock.keys();
  }

  /** True when nothing is decorated — the surface reads this to skip a structural
   *  reassess entirely when no feature is active. */
  get isEmpty(): boolean {
    return this.byBlock.size === 0;
  }

  /** Replace every decoration of one type with a new set — the primary consumer
   *  call (find hands its full match list; spellcheck its full misspelling list).
   *  Notifies the overlay of the union of blocks that changed (blocks losing the
   *  old set ∪ blocks gaining the new), so only those repaint. */
  setType(type: DecorationType, decorations: readonly Decoration[]): void {
    const affected = new Set<string>();
    // Drop the existing decorations of this type, recording the blocks they left.
    for (const [blockId, list] of this.byBlock) {
      const kept = list.filter((d) => d.type !== type);
      if (kept.length === list.length) continue;
      affected.add(blockId);
      if (kept.length === 0) this.byBlock.delete(blockId);
      else this.byBlock.set(blockId, kept);
    }
    // Insert the new set, guarding the type invariant so a caller's stray type
    // can't leak into the wrong bucket.
    for (const dec of decorations) {
      if (dec.type !== type) continue;
      const list = this.byBlock.get(dec.blockId);
      if (list) list.push(dec);
      else this.byBlock.set(dec.blockId, [dec]);
      affected.add(dec.blockId);
    }
    this.notify([...affected]);
  }

  /** Add a single decoration without disturbing others — the fine-grained
   *  counterpart to setType, for incremental producers. */
  add(dec: Decoration): void {
    const list = this.byBlock.get(dec.blockId);
    if (list) list.push(dec);
    else this.byBlock.set(dec.blockId, [dec]);
    this.notify([dec.blockId]);
  }

  /** Remove all decorations of a type (find/spellcheck turning off). */
  clearType(type: DecorationType): void {
    this.setType(type, []);
  }

  /** Remove every decoration. */
  clear(): void {
    if (this.byBlock.size === 0) return;
    const affected = [...this.byBlock.keys()];
    this.byBlock.clear();
    this.notify(affected);
  }

  /** Signal that a block's DOM was rebuilt (a per-keystroke re-render) or — with
   *  `null` — that a structural reconcile / reflow needs a full reassess. The
   *  keystroke path calls this for the edited block on every render; it is O(1) and
   *  short-circuits before touching the overlay when that block carries nothing (or
   *  nothing is decorated at all). */
  invalidate(blockId: string | null): void {
    if (!this.listener) return;
    if (blockId === null) {
      if (this.byBlock.size === 0) return;
      this.listener(null);
      return;
    }
    if (!this.byBlock.has(blockId)) return;
    this.listener([blockId]);
  }

  private notify(dirty: readonly string[]): void {
    if (dirty.length === 0) return;
    this.listener?.(dirty);
  }
}
