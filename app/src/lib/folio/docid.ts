// Document identity for `.folio` (SKR-195, spec §3). Every `.folio` carries a
// stable `docId` minted once at creation and distinct from its path: all managed
// truth (backlinks, history, sidebar structure, collections) keys on `docId`,
// never on path, so a rename or move outside Skrive re-binds by reading the id
// back from the file.
//
// The id is a ULID — 128 bits = a 48-bit millisecond timestamp + 80 bits of
// randomness, Crockford base32, lowercased, 26 chars, no hyphens. Chosen over
// UUIDv4/v7 for being lexicographically creation-time-sortable (a free ordering
// key for the engine's future catalog) while staying filename- and JSON-clean.
//
// Hand-rolled rather than pulling the `ulid` package: the surface is small and
// stable, and this becomes load-bearing at the Zig<->JS boundary where a
// dependency would be an awkward thing to carry. The clock and random source are
// injectable so tests drive a deterministic stream — exactly the pattern
// `../blockmodel/id.ts` already uses for block ids.

// Crockford base32, lowercased. Excludes i, l, o, u to avoid visual ambiguity.
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'; // noscan (base32 alphabet, not a secret)
const TIME_LEN = 10; // 48-bit timestamp -> 10 chars (top 2 bits zero-padded).
const RANDOM_LEN = 16; // 80 bits of randomness -> 16 chars (16 * 5 = 80).

/** Matches a well-formed generated docId. The reader treats `docId` as opaque
 *  (spec §3: uniqueness/opacity/stability are the only hard requirements) and does
 *  NOT enforce this — it is a self-check for the generator and its tests. */
export const DOC_ID_RE = /^[0123456789abcdefghjkmnpqrstvwxyz]{26}$/; // noscan (base32 alphabet)

/** Milliseconds since the Unix epoch. Injected so tests can pin the timestamp. */
export type Clock = () => number;

/** A source of randomness: `length` values, each already reduced to 0-31.
 *  Injected so tests can drive a deterministic stream. */
export type UlidRandom = (length: number) => number[];

// crypto.getRandomValues where available (browser, modern Node), falling back to
// Math.random only if it is not. docIds are identity handles, not secrets, so a
// weak fallback degrades collision odds slightly, never security. A byte modulo 32
// is unbiased here: 256 is an exact multiple of 32.
const defaultRandom: UlidRandom = (length) => {
  const out = new Array<number>(length);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint8Array(length);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < length; i++) out[i] = buf[i]! % 32;
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 32);
  return out;
};

// Encode a 48-bit millisecond timestamp as 10 Crockford chars, most-significant
// first. The value stays within JS's safe-integer range (48 < 53 bits), so the
// modulo/divide walk is exact.
function encodeTime(ms: number): string {
  let t = Math.floor(ms);
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(draws: number[]): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) out += CROCKFORD[(draws[i]! | 0) % 32];
  return out;
}

/**
 * Build a docId generator over a clock and random source. The default generator
 * uses `Date.now()` and crypto; pass a fixed clock and a seeded source for
 * deterministic tests.
 */
export function makeDocIdGenerator(
  clock: Clock = () => Date.now(),
  random: UlidRandom = defaultRandom
): () => string {
  return () => encodeTime(clock()) + encodeRandom(random(RANDOM_LEN));
}

/** The default docId generator (system clock + crypto randomness). */
export const generateDocId = makeDocIdGenerator();
