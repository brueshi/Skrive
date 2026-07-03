// Where an exported file lands. Export writes into the project folder beside the
// source (the decision that keeps SKR-199 off the Zig host — reusing the
// extension-agnostic `fs.writeFile`). Collision-safe by design: an export never
// clobbers an existing file. Re-exporting yields `name 1.ext`, `name 2.ext`, …
// rather than silently overwriting a same-named hand-authored document (e.g. a
// `notes.md` sitting next to `notes.folio`). Data safety over convenience.

/** Compute a collision-free, project-relative target path for exporting
 *  `sourcePath` to `extension`. `exists` reports whether a candidate path is
 *  already taken (checked against the live manifest). */
export function exportTargetPath(
  sourcePath: string,
  extension: string,
  exists: (path: string) => boolean
): string {
  const slash = sourcePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : sourcePath.slice(0, slash + 1);
  const leaf = slash === -1 ? sourcePath : sourcePath.slice(slash + 1);
  // Drop the source extension (`.folio`); keep any earlier dots in the stem.
  const stem = leaf.replace(/\.[^.]+$/, '');
  const base = `${dir}${stem}`;

  let candidate = `${base}.${extension}`;
  let n = 1;
  while (exists(candidate)) {
    candidate = `${base} ${n}.${extension}`;
    n++;
  }
  return candidate;
}
