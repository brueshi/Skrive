// Undo/redo history for the block surface (SKR-127). The model is rebuilt
// immutably on every edit (each `this.doc = { ...this.doc, … }`), so a snapshot
// is just a reference to a past Document plus the selection at that point —
// cheap, and unchanged blocks are shared across snapshots by reference.
//
// Coalescing: consecutive same-kind edits (a run of typing, a run of deletes)
// within a short window collapse into one undo step, so undo doesn't replay
// keystroke by keystroke. Any other edit kind (paste, structural, marks) is its
// own step. A new edit clears the redo stack; undo/redo break the coalescing run.

import type { Document } from '../blockmodel';
import type { DocRange } from './doc-position';

export type EditKind = 'type' | 'delete' | 'other';

export interface DocSnapshot {
  doc: Document;
  sel: DocRange | null;
}

// Typing pauses longer than this start a fresh undo step.
const COALESCE_MS = 600;
// Bound the stacks so a long session can't grow history without limit. Snapshots
// share structure, so this is generous.
const CAP = 250;

export class DocHistory {
  private past: DocSnapshot[] = [];
  private future: DocSnapshot[] = [];
  private lastKind: EditKind | null = null;
  private lastAt = 0;

  /** Record the pre-edit state before an edit of `kind` is applied. `sel` is a
   *  thunk so the selection is only read when a snapshot is actually pushed
   *  (coalesced keystrokes never touch the DOM). */
  record(doc: Document, sel: () => DocRange | null, kind: EditKind, now: number): void {
    const coalesce =
      (kind === 'type' || kind === 'delete') &&
      kind === this.lastKind &&
      now - this.lastAt < COALESCE_MS &&
      this.past.length > 0;
    this.lastKind = kind;
    this.lastAt = now;
    if (coalesce) return;
    this.future = [];
    this.past.push({ doc, sel: sel() });
    if (this.past.length > CAP) this.past.shift();
  }

  /** Pop the previous state, banking `current` for redo. Null when nothing to
   *  undo. The caller applies the returned snapshot (doc + selection). */
  undo(current: DocSnapshot): DocSnapshot | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    this.lastKind = null;
    return prev;
  }

  /** Pop the next state, banking `current` for undo. Null when nothing to redo. */
  redo(current: DocSnapshot): DocSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.lastKind = null;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
