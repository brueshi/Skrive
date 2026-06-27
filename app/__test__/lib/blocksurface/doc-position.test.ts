// Document position model (SKR-118, Stage 1). The pure leaf/position helpers; the
// DOM selection map (readSelection/writeSelection) is exercised by the harness.

import { describe, it, expect } from 'vitest';
import {
  collapsedRange,
  isCollapsed,
  sameLeaf,
  samePos,
  type DocPos
} from '../../../src/lib/blocksurface/doc-position';

describe('leaf identity', () => {
  it('compares block leaves by id', () => {
    expect(sameLeaf({ kind: 'block', id: 'a' }, { kind: 'block', id: 'a' })).toBe(true);
    expect(sameLeaf({ kind: 'block', id: 'a' }, { kind: 'block', id: 'b' })).toBe(false);
  });

  it('compares cell leaves by table id + coordinates', () => {
    const c = { kind: 'cell', tableId: 't', row: 1, col: 2 } as const;
    expect(sameLeaf(c, { kind: 'cell', tableId: 't', row: 1, col: 2 })).toBe(true);
    expect(sameLeaf(c, { kind: 'cell', tableId: 't', row: 1, col: 3 })).toBe(false);
  });

  it('a block and a cell are never the same leaf', () => {
    expect(sameLeaf({ kind: 'block', id: 't' }, { kind: 'cell', tableId: 't', row: 0, col: 0 })).toBe(false);
  });
});

describe('positions and ranges', () => {
  const pos: DocPos = { leaf: { kind: 'block', id: 'a' }, offset: 3 };

  it('samePos needs both leaf and offset', () => {
    expect(samePos(pos, { leaf: { kind: 'block', id: 'a' }, offset: 3 })).toBe(true);
    expect(samePos(pos, { leaf: { kind: 'block', id: 'a' }, offset: 4 })).toBe(false);
  });

  it('collapsedRange is collapsed; a two-point range is not', () => {
    expect(isCollapsed(collapsedRange(pos))).toBe(true);
    expect(isCollapsed({ anchor: pos, focus: { leaf: { kind: 'block', id: 'b' }, offset: 0 } })).toBe(false);
  });
});
