// @vitest-environment jsdom
//
// Live word counting over the block surface DOM (SKR-53). Two contracts:
// blockText's word-boundary semantics — block-level element boundaries
// separate words (adjacent list items / table cells never join) while inline
// mark boundaries never split one — and attachLiveCounts' incremental
// bookkeeping across text edits, block insertion/removal, and detach.

import { describe, expect, it, vi } from 'vitest';
import {
  attachLiveCounts,
  blockText,
  countBlock,
  type LiveCounts
} from '../../src/lib/wordcount/live';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

/** MutationObserver delivery + the module's rAF flush. jsdom implements
 *  both; two macrotask turns let the microtask records land first. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => setTimeout(r, 0));
}

describe('blockText', () => {
  it('keeps inline marks inside one word', () => {
    const p = el('<p>he<strong>ll</strong>o world</p>');
    expect(countBlock(p).words).toBe(2);
  });

  it('separates adjacent list items', () => {
    const ul = el('<ul><li>alpha</li><li>beta</li></ul>');
    expect(countBlock(ul).words).toBe(2);
  });

  it('separates table cells', () => {
    const table = el(
      '<table><tbody><tr><td>one</td><td>two</td></tr><tr><td>three</td><td>four</td></tr></tbody></table>'
    );
    expect(countBlock(table).words).toBe(4);
  });

  it('treats hard breaks as boundaries', () => {
    const p = el('<p>first<br>second</p>');
    expect(blockText(p)).toContain('\n');
    expect(countBlock(p).words).toBe(2);
  });

  it('counts characters from the visible text, without separators', () => {
    const ul = el('<ul><li>ab</li><li>cd</li></ul>');
    expect(countBlock(ul).chars).toBe(4);
  });
});

describe('attachLiveCounts', () => {
  function mount(html: string) {
    const content = document.createElement('div');
    content.innerHTML = html;
    document.body.appendChild(content);
    const seen: LiveCounts[] = [];
    const detach = attachLiveCounts(content, (c) => seen.push(c));
    return { content, seen, detach };
  }

  it('reports the initial totals synchronously', () => {
    const { seen, detach } = mount('<p>one two</p><p>three</p>');
    expect(seen[0]).toEqual({ words: 3, chars: 12 });
    detach();
  });

  it('tracks a text edit inside one block', async () => {
    const { content, seen, detach } = mount('<p>one two</p>');
    content.querySelector('p')!.firstChild!.nodeValue = 'one two three';
    await settle();
    expect(seen.at(-1)).toEqual({ words: 3, chars: 13 });
    detach();
  });

  it('tracks block insertion and removal', async () => {
    const { content, seen, detach } = mount('<p>one</p>');
    const p = document.createElement('p');
    p.textContent = 'two three';
    content.appendChild(p);
    await settle();
    expect(seen.at(-1)).toEqual({ words: 3, chars: 12 });

    content.removeChild(content.firstElementChild!);
    await settle();
    expect(seen.at(-1)).toEqual({ words: 2, chars: 9 });
    detach();
  });

  it('does not report when an edit leaves the totals unchanged', async () => {
    const { content, seen, detach } = mount('<p>one two</p>');
    const before = seen.length;
    // Same word and character counts, different text.
    content.querySelector('p')!.firstChild!.nodeValue = 'two one';
    await settle();
    expect(seen.length).toBe(before);
    detach();
  });

  it('stops reporting after detach', async () => {
    const { content, seen, detach } = mount('<p>one</p>');
    detach();
    const before = seen.length;
    content.querySelector('p')!.firstChild!.nodeValue = 'one two three four';
    await settle();
    expect(seen.length).toBe(before);
  });

  it('coalesces a burst of edits into one report', async () => {
    const { content, seen, detach } = mount('<p>seed</p>');
    const before = seen.length;
    const text = content.querySelector('p')!.firstChild!;
    text.nodeValue = 'a';
    text.nodeValue = 'a b';
    text.nodeValue = 'a b c';
    await settle();
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toEqual({ words: 3, chars: 5 });
    detach();
    vi.restoreAllMocks();
  });
});
