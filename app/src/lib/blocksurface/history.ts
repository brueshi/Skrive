// Undo/redo history for the block surface (SKR-127). The model is rebuilt
// immutably on every edit (each `this.doc = { ...this.doc, … }`), so a snapshot
// is just a reference to a past Document plus the selection at that point —
// cheap, and unchanged blocks are shared across snapshots by reference.
//
// Coalescing (rules tightened in SKR-178): consecutive same-kind edits collapse
// into one undo step only while they stay in the SAME target (leaf / cell), come
// within a short idle gap of each other, AND the run as a whole stays under a
// hard cap measured from its first record — so continuous typing can never
// become one giant step, and typing in block A then block B never merges. An
// explicit break (a whitespace insert) ends a run early, so undo steps word by
// word through prose. Any other edit kind (paste, structural, marks) is its own
// step. A new edit clears the redo stack; undo/redo break the coalescing run.

import type { Document } from '../blockmodel';
import type { DocRange } from './doc-position';

export type EditKind = 'type' | 'delete' | 'other';

/** What the surface tells history about the edit being applied: its kind
 *  ('type'/'delete' coalesce, 'other' never does), the leaf or cell it lands in
 *  (a run never crosses targets), and an explicit run break (a whitespace
 *  insert starts a fresh step even mid-run). */
export type EditHint = { kind: EditKind; target?: string | null; breakRun?: boolean };

export interface DocSnapshot {
  doc: Document;
  sel: DocRange | null;
}

// Typing pauses longer than this start a fresh undo step.
const COALESCE_MS = 600;
// A coalescing run's total span, measured from its FIRST record — the sliding
// idle window alone let uninterrupted typing coalesce without bound (F37).
const RUN_CAP_MS = 3000;
// Bound the stacks so a long session can't grow history without limit. Snapshots
// share structure, so this is generous.
const CAP = 250;

export class DocHistory {
  private past: DocSnapshot[] = [];
  private future: DocSnapshot[] = [];
  private lastKind: EditKind | null = null;
  private lastTarget: string | null = null;
  private lastAt = 0;
  private runStartAt = 0;

  /** Record the pre-edit state before an edit described by `hint` is applied.
   *  `sel` is a thunk so the selection is only read when a snapshot is actually
   *  pushed (coalesced keystrokes never touch the DOM). */
  record(doc: Document, sel: () => DocRange | null, hint: EditHint, now: number): void {
    const { kind, target = null, breakRun = false } = hint;
    const coalesce =
      (kind === 'type' || kind === 'delete') &&
      !breakRun &&
      kind === this.lastKind &&
      target === this.lastTarget &&
      now - this.lastAt < COALESCE_MS &&
      now - this.runStartAt < RUN_CAP_MS &&
      this.past.length > 0;
    this.lastKind = kind;
    this.lastTarget = target;
    this.lastAt = now;
    if (coalesce) return;
    this.runStartAt = now;
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
    this.lastTarget = null;
    return prev;
  }

  /** Pop the next state, banking `current` for undo. Null when nothing to redo. */
  redo(current: DocSnapshot): DocSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.lastKind = null;
    this.lastTarget = null;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
