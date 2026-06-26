// The durable-anchor grammar and the attachment-registry seam (SKR-96). The
// registry is exercised empty: Stage 1 proves the API exists and starts clean.

import { describe, it, expect } from 'vitest';
import {
  InMemoryAttachmentRegistry,
  formatAnchorComment,
  parseAnchorComment
} from '../../../src/lib/blockmodel/anchor';

describe('anchor comment grammar', () => {
  it('parses an id out of a well-formed comment', () => {
    expect(parseAnchorComment('<!-- sk:abc123 -->')).toBe('abc123');
  });

  it('tolerates whitespace variants', () => {
    expect(parseAnchorComment('<!--sk:abc123-->')).toBe('abc123');
    expect(parseAnchorComment('<!--   sk:abc123   -->')).toBe('abc123');
    expect(parseAnchorComment('  <!-- sk:abc123 -->  ')).toBe('abc123');
  });

  it('rejects non-anchor comments and malformed ids', () => {
    expect(parseAnchorComment('<!-- a normal comment -->')).toBeNull();
    expect(parseAnchorComment('<!-- sk:ABC123 -->')).toBeNull(); // uppercase not in the id alphabet
    expect(parseAnchorComment('<!-- sk:abc-123 -->')).toBeNull(); // dash not in the id alphabet
    expect(parseAnchorComment('<!-- sk: -->')).toBeNull(); // empty id
    expect(parseAnchorComment('plain text')).toBeNull();
  });

  it('round-trips format → parse', () => {
    const id = 'q1w2e3r4t5';
    expect(parseAnchorComment(formatAnchorComment(id))).toBe(id);
  });
});

describe('InMemoryAttachmentRegistry', () => {
  it('starts empty', () => {
    const reg = new InMemoryAttachmentRegistry();
    expect(reg.size).toBe(0);
    expect(reg.attachedIds()).toEqual([]);
    expect(reg.has('anything')).toBe(false);
    expect(reg.get('anything')).toBeUndefined();
  });

  it('attaches, reads, and detaches by block id', () => {
    const reg = new InMemoryAttachmentRegistry<{ note: string }>();
    reg.attach('blk1', { note: 'hi' });
    expect(reg.has('blk1')).toBe(true);
    expect(reg.get('blk1')).toEqual({ note: 'hi' });
    expect(reg.attachedIds()).toEqual(['blk1']);
    expect(reg.size).toBe(1);

    reg.detach('blk1');
    expect(reg.has('blk1')).toBe(false);
    expect(reg.size).toBe(0);
  });
});
