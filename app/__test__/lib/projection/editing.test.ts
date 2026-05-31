// Live dirty-tracking + the boundary wall, via real ProseMirror transactions
// (no DOM). See planning/projection-editor-master-plan.md (Stage 1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';
import { dirtyPlugin } from '../../../src/lib/projection/dirty';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(resolve(here, 'fixture.md'), 'utf8');

function stateFrom(text: string): EditorState {
  return EditorState.create({ doc: parseDoc(text), plugins: [dirtyPlugin] });
}

function findBlock(doc: PMNode, predicate: (b: PMNode) => boolean): { block: PMNode; offset: number } {
  let result: { block: PMNode; offset: number } | null = null;
  doc.forEach((block, offset) => {
    if (!result && predicate(block)) result = { block, offset };
  });
  if (!result) throw new Error('block not found');
  return result;
}

function dirtyBlockTexts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((b) => {
    if (b.attrs.dirty) out.push(b.textContent);
  });
  return out;
}

describe('projection live dirty-tracking', () => {
  it('seam 2 (live) — a real edit marks ONLY the touched block dirty', () => {
    const state = stateFrom(md);
    const { block, offset } = findBlock(state.doc, (b) => b.textContent.includes('closing paragraph'));
    const pos = offset + block.nodeSize - 1; // inside the paragraph, at its end
    const next = state.apply(state.tr.insertText(' EDITED', pos));

    const dirty = dirtyBlockTexts(next.doc);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain('closing paragraph');

    const out = serializeDoc(next.doc);
    expect(out).toContain('EDITED');
    expect(out).toContain('* first bullet'); // untouched list stays verbatim
    expect(out).toContain('```ts'); // untouched code fence stays verbatim
  });

  it('block-granularity: editing one item dirties the whole list but the marker is preserved', () => {
    const state = stateFrom(md);
    const { offset } = findBlock(state.doc, (b) => b.type.name === 'bullet_list');
    const next = state.apply(state.tr.insertText('X', offset + 3)); // inside first item

    expect(dirtyBlockTexts(next.doc)).toHaveLength(1); // whole list is dirty (block granularity)

    const out = serializeDoc(next.doc);
    expect(out).toContain('X');
    expect(out).toContain('* second bullet'); // non-canonical `*` preserved, not churned to `-`
    expect(out).not.toContain('- second bullet');
  });

  it('seam survives editing the adjacent block — the gap before an untouched block is unchanged', () => {
    const state = stateFrom(md);
    // Edit the FIRST block (the heading); the paragraph after it is untouched and
    // owns the seam between them, which must stay verbatim.
    const { block, offset } = findBlock(state.doc, (b) => b.type.name === 'heading');
    const endOfHeading = offset + block.nodeSize - 1;
    const next = state.apply(state.tr.insertText(' more', endOfHeading));
    const out = serializeDoc(next.doc);
    // The heading -> paragraph seam (a blank line) is intact, content edited.
    expect(out).toContain('# Projection fixture more\n\nA paragraph with');
  });
});

describe('projection boundary wall (the thing that killed the CM6 spike)', () => {
  function boldWordState(): EditorState {
    const strong = schema.marks.strong.create();
    const para = schema.node('paragraph', { src: null, gapBefore: '', dirty: true }, [
      schema.text('bold', [strong])
    ]);
    const doc = schema.node('doc', { trailingGap: '' }, [para]);
    return EditorState.create({ doc, plugins: [dirtyPlugin] });
  }

  it('extending a bold span stays valid — serializes to **bold word**, never **bold **', () => {
    const strong = schema.marks.strong.create();
    const state = boldWordState();
    const next = state.apply(state.tr.insert(5, schema.text(' word', [strong])));
    expect(serializeDoc(next.doc)).toBe('**bold word**');
  });

  it('typing past the bold boundary keeps the bold intact — no silent vanish', () => {
    const state = boldWordState();
    const next = state.apply(state.tr.insert(5, schema.text(' word')));
    expect(serializeDoc(next.doc)).toBe('**bold** word');
  });
});
