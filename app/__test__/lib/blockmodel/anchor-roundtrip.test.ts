// Durable-anchor round-trip (SKR-94 / SKR-96). The disk contract: a pristine
// document carries no anchor comments; a block with an attachment carries exactly
// one `<!-- sk:ID -->` comment immediately before it, and that comment round-trips
// byte-for-byte. Stage 1 exercises the mechanism with no live attachments — the
// registry is empty — by setting the model's `durable` flag directly, which is
// what the managed layer (B2) will do when it attaches.

import { describe, it, expect } from 'vitest';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';

describe('pristine documents stay pristine', () => {
  it('assigns no durable flags and emits no anchor comments', () => {
    const md = 'First paragraph.\n\nSecond paragraph.\n';
    const doc = parseDocument(md);
    expect(doc.blocks.every((b) => b.durable === false)).toBe(true);
    const out = serializeDocument(doc);
    expect(out).toBe(md);
    expect(out).not.toContain('sk:');
  });
});

describe('authored durable anchors', () => {
  const md = 'First paragraph.\n\n<!-- sk:abc123def0 -->\nAnchored paragraph.\n';

  it('binds the id to the following block and consumes the comment', () => {
    const doc = parseDocument(md);
    expect(doc.blocks).toHaveLength(2);
    const [first, second] = doc.blocks;
    expect(first!.durable).toBe(false);
    expect(second!.durable).toBe(true);
    expect(second!.id).toBe('abc123def0');
    // The comment is not content: the anchored block's src is the prose alone.
    expect(second!.type === 'paragraph' && second!.src).toBe('Anchored paragraph.');
  });

  it('round-trips byte-for-byte', () => {
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });

  it('a non-anchor HTML comment is not consumed (stays a frozen block)', () => {
    const withComment = 'Para.\n\n<!-- just a note -->\n\nMore.\n';
    const doc = parseDocument(withComment);
    expect(doc.blocks.every((b) => b.durable === false)).toBe(true);
    expect(serializeDocument(doc)).toBe(withComment);
  });
});

describe('simulated attachment (what the managed layer will do)', () => {
  it('emits, re-parses, and round-trips a comment when a block is marked durable', () => {
    const md = 'Alpha.\n\nBravo.\n';
    const doc = parseDocument(md);
    // Mark the second block durable, as registry.attach() will.
    const target = doc.blocks[1]!;
    const durableDoc = {
      ...doc,
      blocks: doc.blocks.map((b) => (b === target ? { ...b, durable: true } : b))
    };

    const out = serializeDocument(durableDoc);
    expect(out).toContain(`<!-- sk:${target.id} -->`);

    // The emitted document re-parses with the durable id restored, and is stable.
    const reparsed = parseDocument(out);
    const reAnchored = reparsed.blocks.find((b) => b.durable);
    expect(reAnchored?.id).toBe(target.id);
    expect(serializeDocument(reparsed)).toBe(out);
  });
});
