// The outline rail's invalidation key. The rail re-measures heading DOM
// positions only when this key changes, so it must change for every edit
// that alters heading structure (count, level, text) and stay stable for
// body-only edits — that stability is the whole point: a paragraph edit
// must not re-trigger the rail's querySelectorAll + rect sweep.

import { describe, expect, it } from 'vitest';
import { headingStructureKey } from '../../src/components/editor/Preview';
import { renderMarkdown } from '../../src/lib/preview/markdown';

const key = (md: string) => headingStructureKey(renderMarkdown(md));

describe('headingStructureKey', () => {
  it('is empty for a document with no headings', () => {
    expect(key('Just a paragraph.\n\nAnd another.')).toBe('');
  });

  it('stays stable across paragraph-only edits', () => {
    const before = key('# Title\n\nSome prose here.\n\n## Section\n\nMore.');
    const after = key('# Title\n\nSome prose, edited.\n\n## Section\n\nMore?');
    expect(after).toBe(before);
  });

  it('changes when a heading is renamed', () => {
    expect(key('# Title\n\nBody.')).not.toBe(key('# Titles\n\nBody.'));
  });

  it('changes when a heading changes level', () => {
    expect(key('## Section')).not.toBe(key('### Section'));
  });

  it('changes when a heading is added or removed', () => {
    const one = key('# Title\n\nBody.');
    const two = key('# Title\n\nBody.\n\n## Added');
    expect(two).not.toBe(one);
    expect(headingStructureKey('')).toBe('');
  });

  it('captures every heading in document order', () => {
    const k = key('# One\n\n## Two\n\n### Three');
    expect(k).toContain('id="one"');
    expect(k).toContain('id="two"');
    expect(k).toContain('id="three"');
    expect(k.indexOf('id="one"')).toBeLessThan(k.indexOf('id="three"'));
  });

  it('ignores heading-shaped text inside code blocks', () => {
    const base = key('# Title');
    const withCode = key('# Title\n\n```\n# not a heading\n<h2>nor this</h2>\n```');
    expect(withCode).toBe(base);
  });

  it('changes when inline markup inside a heading changes (conservative)', () => {
    // Deliberate: a spurious re-measure is cheap, a missed one means
    // stale ticks, so the key tracks the raw heading markup.
    expect(key('# A **bold** word')).not.toBe(key('# A bold word'));
  });

  it('distinguishes duplicate headings via their de-duplicated ids', () => {
    // Two same-text headings collapse to one tag's worth of text, but the
    // slug deduper gives them distinct ids, so count changes still show.
    expect(key('## Notes\n\n## Notes')).not.toBe(key('## Notes'));
  });
});
