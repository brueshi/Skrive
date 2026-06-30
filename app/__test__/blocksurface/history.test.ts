// DocHistory (SKR-127): undo/redo stack + coalescing. Pure logic — snapshots are
// opaque to the stack, so the tests use distinct stub docs and compare by identity.

import { describe, expect, it } from 'vitest';
import { DocHistory } from '../../src/lib/blocksurface/history';
import type { Document } from '../../src/lib/blockmodel';

// Distinct identities standing in for document versions.
const doc = (tag: string): Document => ({ blocks: [], trailingGap: tag }) as Document;
const NO_SEL = () => null;
const cur = (d: Document) => ({ doc: d, sel: null });

describe('DocHistory', () => {
  it('records pre-edit snapshots and undoes/redoes in order', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    const d1 = doc('1');
    const d2 = doc('2');
    h.record(d0, NO_SEL, 'other', 1000); // before the edit producing d1
    h.record(d1, NO_SEL, 'other', 2000); // before the edit producing d2

    expect(h.undo(cur(d2))?.doc).toBe(d1);
    expect(h.undo(cur(d1))?.doc).toBe(d0);
    expect(h.undo(cur(d0))).toBeNull();

    expect(h.redo(cur(d0))?.doc).toBe(d1);
    expect(h.redo(cur(d1))?.doc).toBe(d2);
    expect(h.redo(cur(d2))).toBeNull();
  });

  it('coalesces consecutive same-kind edits within the window into one step', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    h.record(d0, NO_SEL, 'type', 1000); // first keystroke pushes
    h.record(doc('1'), NO_SEL, 'type', 1100); // coalesces
    h.record(doc('2'), NO_SEL, 'type', 1300); // coalesces
    expect(h.undo(cur(doc('3')))?.doc).toBe(d0);
    expect(h.canUndo).toBe(false);
  });

  it('breaks coalescing across a time gap', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    const d1 = doc('1');
    h.record(d0, NO_SEL, 'type', 1000);
    h.record(d1, NO_SEL, 'type', 2000); // >600ms later: a new step
    expect(h.undo(cur(doc('2')))?.doc).toBe(d1);
    expect(h.undo(cur(d1))?.doc).toBe(d0);
  });

  it('breaks coalescing when the edit kind changes', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    const d1 = doc('1');
    h.record(d0, NO_SEL, 'type', 1000);
    h.record(d1, NO_SEL, 'delete', 1050); // different kind: a new step
    expect(h.undo(cur(doc('2')))?.doc).toBe(d1);
    expect(h.undo(cur(d1))?.doc).toBe(d0);
  });

  it("never coalesces 'other' edits", () => {
    const h = new DocHistory();
    const d0 = doc('0');
    const d1 = doc('1');
    h.record(d0, NO_SEL, 'other', 1000);
    h.record(d1, NO_SEL, 'other', 1010);
    expect(h.undo(cur(doc('2')))?.doc).toBe(d1);
    expect(h.undo(cur(d1))?.doc).toBe(d0);
  });

  it('a new edit clears the redo stack', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    h.record(d0, NO_SEL, 'other', 1000);
    h.undo(cur(doc('1')));
    expect(h.canRedo).toBe(true);
    h.record(doc('2'), NO_SEL, 'other', 1100); // new edit
    expect(h.canRedo).toBe(false);
  });

  it('undo breaks the coalescing run so the next edit starts a fresh step', () => {
    const h = new DocHistory();
    const d0 = doc('0');
    const d1 = doc('1');
    h.record(d0, NO_SEL, 'type', 1000); // run A: pushes d0
    h.undo(cur(d1)); // restores d0, banks d1 for redo, breaks run
    h.record(d1, NO_SEL, 'type', 1100); // fresh run: pushes d1, clears redo
    expect(h.canRedo).toBe(false);
    expect(h.undo(cur(doc('2')))?.doc).toBe(d1); // the fresh edit is its own step
    expect(h.canUndo).toBe(false); // d0 was already consumed by the earlier undo
  });

  it('only reads the selection when a snapshot is actually pushed', () => {
    const h = new DocHistory();
    let reads = 0;
    const sel = () => {
      reads++;
      return null;
    };
    h.record(doc('0'), sel, 'type', 1000); // pushes -> 1 read
    h.record(doc('1'), sel, 'type', 1100); // coalesces -> no read
    h.record(doc('2'), sel, 'type', 1200); // coalesces -> no read
    expect(reads).toBe(1);
  });
});
