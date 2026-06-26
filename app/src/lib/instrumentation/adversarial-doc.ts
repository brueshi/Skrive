// Adversarial document generator for the keystroke→paint gate.
//
// The gate's hardest claim is *constant-time*: a glyph must land in the same
// number of milliseconds whether the cursor sits in block 1 or block 10,000,
// in a plain block or one carrying a durable anchor, while the cold path churns
// (planning/editor-surface-build-plan.md, "The core gate"). To test that we need
// a document large and varied enough to expose anything document-sized that has
// leaked onto the hot path.
//
// Pure and deterministic (a seeded mulberry32 stream, no Date.now / Math.random),
// so the same options always produce byte-identical Markdown — the harness can
// regenerate a 10k-block doc in CI without committing a megabyte fixture, and a
// regression is never noise from a reshuffled corpus.
//
// The block model and durable anchors do not exist yet at Stage 0; today's
// editor has no anchor cost because it has no anchors. The `<!-- sk:ID -->`
// comments are emitted anyway: against today's projection they parse as frozen
// blocks (typing next to an immovable atom is itself a real adversarial axis),
// and they make the "anchor-bearing block" matrix row a wired, ready scenario
// that later stages light up for free.

/** Stable text the Playwright driver searches for to place the caret in a known
 *  block, independent of how the corpus shuffles around it. */
export const FIRST_BLOCK_MARKER = 'SKRIVE_FIRST_BLOCK';
export const LAST_BLOCK_MARKER = 'SKRIVE_LAST_BLOCK';
export const ANCHORED_BLOCK_MARKER = 'SKRIVE_ANCHORED_BLOCK';

export type AdversarialDocOptions = {
  /** Number of content blocks to emit (excludes anchor-comment blocks). */
  blocks: number;
  /** Emit a `<!-- sk:ID -->` anchor comment before every Nth content block.
   *  0 disables anchors entirely. */
  anchorEvery?: number;
  /** PRNG seed. Fixed default keeps corpora byte-stable across runs. */
  seed?: number;
};

export type AdversarialDoc = {
  markdown: string;
  /** Content blocks emitted (matches `options.blocks`). */
  blockCount: number;
  /** Anchor comments emitted. */
  anchorCount: number;
};

// Reproducible PRNG (mulberry32), mirroring scripts/build-perf-fixture.ts so the
// instrumentation corpus and the cold-open corpus share one determinism story.
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARAGRAPHS = [
  'The structure of the page is the structure of the thought; every paragraph break is a breath and every section header a decision about what belongs together.',
  'A draft is a working hypothesis about what the piece is about, and revision is the slow business of testing that hypothesis against the actual sentences.',
  'There is a difference between writing meant to be read once and writing meant to be read again; the second is rarer and asks for more patience.',
  'The blank page is not the problem. The problem is the page that is mostly working, and knowing what to keep without losing the thread.',
  'Notes are not drafts, drafts are not pieces, and pieces are not finished work; each transition demands a different kind of attention.',
  'A good link is a promise that the place it sends you is worth the detour, and a bad one is a tax on the reader for clarity left out of the prose.'
];

const HEADINGS = [
  'On revision',
  'The shape of an argument',
  'Against tidiness',
  'Notes toward a method',
  'What the draft knows'
];

const LIST_ITEMS = [
  'keep the sentence that does two jobs',
  'cut the connective that does none',
  'name the thing before describing it',
  'let the example carry the claim'
];

// Emit one content block of a type chosen by the stream. Headings, lists,
// quotes, and the occasional code block keep the parser doing varied structural
// work rather than measuring one homogeneous paragraph path.
function emitBlock(rng: () => number, index: number): string {
  const roll = rng();
  if (roll < 0.12) {
    return `## ${HEADINGS[Math.floor(rng() * HEADINGS.length)]}`;
  }
  if (roll < 0.24) {
    const n = 2 + Math.floor(rng() * 3);
    const items: string[] = [];
    for (let i = 0; i < n; i++) {
      items.push(`- ${LIST_ITEMS[Math.floor(rng() * LIST_ITEMS.length)]}`);
    }
    return items.join('\n');
  }
  if (roll < 0.3) {
    return `> ${PARAGRAPHS[Math.floor(rng() * PARAGRAPHS.length)]}`;
  }
  if (roll < 0.34) {
    return ['```ts', `const block = ${index}; // a fenced span the parser must skip`, '```'].join('\n');
  }
  // Default: a prose paragraph, occasionally carrying an inline link and an
  // emphasis run so the inline parser has real marks to resolve.
  let text = PARAGRAPHS[Math.floor(rng() * PARAGRAPHS.length)]!;
  if (rng() < 0.3) text = `${text} See [the note](./notes/${index}.md) for context.`;
  if (rng() < 0.3) text = text.replace('the', '*the*');
  return text;
}

/**
 * Build a deterministic adversarial Markdown document.
 *
 * The first content block is prefixed with {@link FIRST_BLOCK_MARKER}, the last
 * with {@link LAST_BLOCK_MARKER}, and the first anchor-adjacent block with
 * {@link ANCHORED_BLOCK_MARKER}, so the matrix driver can position the caret in
 * a known block at either end of an arbitrarily large corpus.
 */
export function buildAdversarialDoc(options: AdversarialDocOptions): AdversarialDoc {
  const { blocks, anchorEvery = 0, seed = 0xc0ffee } = options;
  if (blocks < 1) throw new Error(`blocks must be >= 1, got ${blocks}`);

  const rng = makeRng(seed);
  const out: string[] = [];
  let anchorCount = 0;
  let anchoredMarked = false;

  for (let i = 0; i < blocks; i++) {
    const wantAnchor = anchorEvery > 0 && i > 0 && i % anchorEvery === 0;
    if (wantAnchor) {
      // A deterministic, opaque id in the durable-anchor comment shape. The id
      // derives from the block index so the corpus stays byte-stable.
      out.push(`<!-- sk:${(0x100000 + i).toString(16)} -->`);
      anchorCount++;
    }

    let block = emitBlock(rng, i);
    if (i === 0) block = `${FIRST_BLOCK_MARKER}. ${block}`;
    if (i === blocks - 1) block = `${block} ${LAST_BLOCK_MARKER}.`;
    if (wantAnchor && !anchoredMarked) {
      block = `${ANCHORED_BLOCK_MARKER}. ${block}`;
      anchoredMarked = true;
    }
    out.push(block);
  }

  return {
    markdown: out.join('\n\n') + '\n',
    blockCount: blocks,
    anchorCount
  };
}
