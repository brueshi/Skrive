// Block-stable identity (SKR-94). Each block carries a durable id that survives
// edits within a session and, for anchor-bearing blocks, across reloads via the
// `<!-- sk:ID -->` comment (anchor.ts).
//
// The key insight from the disk contract: durable id ⟺ has an attachment ⟺
// carries a comment. A block with no attachment needs no cross-reload stability,
// because nothing in the managed layer keys to it — so it gets a fresh session
// id each load, and only attachment-bearing blocks persist their id. That keeps a
// pristine document pristine (no ids leaking into the bytes) while giving the
// managed layer a stable handle exactly where it needs one.
//
// The id-survival contract the editing layer (Stage 3) must honor:
//   - edit:    the block keeps its id.
//   - split:   the original keeps its id; the new block mints a fresh one.
//   - merge:   the survivor keeps its id; the absorbed id is released.
//   - reorder: the id travels with its block.
// Stage 1 ships the generator, the grammar, and this contract; the commands that
// uphold it arrive with the editing surface.

// Opaque, lowercase alphanumeric so it drops into an HTML comment and a SQLite
// key without escaping. 10 base-36 chars from 50 bits of randomness — ample
// collision resistance for the per-document block counts we deal with, while
// staying short enough to be unobtrusive in the file.
const ID_LENGTH = 10;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Matches a well-formed block id. The anchor grammar restricts to this set. */
export const BLOCK_ID_RE = /^[0-9a-z]+$/;

/** A source of randomness. Injected so tests can drive a deterministic stream. */
export type RandomSource = (length: number) => number[];

// crypto.getRandomValues where available (browser, modern Node), falling back to
// Math.random only if it is not — the ids are identity handles, not secrets, so a
// weak fallback degrades collision odds slightly, never security.
const defaultRandom: RandomSource = (length) => {
  const out = new Array<number>(length);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint32Array(length);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < length; i++) out[i] = buf[i]!;
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 0x100000000);
  return out;
};

/**
 * Build an id generator over a random source. The default generator uses crypto;
 * pass a seeded source for deterministic tests (e.g. a counter or mulberry32).
 */
export function makeIdGenerator(random: RandomSource = defaultRandom): () => string {
  return () => {
    const draws = random(ID_LENGTH);
    let id = '';
    for (let i = 0; i < ID_LENGTH; i++) {
      id += ALPHABET[Math.abs(draws[i]! | 0) % ALPHABET.length];
    }
    return id;
  };
}

/** The default, crypto-backed block id generator. */
export const generateBlockId = makeIdGenerator();
