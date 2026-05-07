// YAML frontmatter parser, serializer, and project-wide schema inference.
//
// Ported from src-tauri/src/frontmatter.rs (parse + serialize) and
// src-tauri/src/project.rs::infer_schema. Lives in `shared/` because both
// the shell (project scan) and the renderer (panel + autosave) parse and
// serialize frontmatter — duplicating the implementation across two
// bundles would be the worst kind of "synchronized state."
//
// The Markdown-in-the-wild rule from the Rust core applies here too:
// `---` is also a horizontal rule, a setext heading underline, and the
// thing every author has at the top of a file by accident. Fail loud
// here and the project scan refuses to open. So everything is lenient:
//   - No opening fence → whole source is body.
//   - Opening fence but no closing fence → whole source is body.
//   - Empty body between fences → empty frontmatter, body after the close.
//   - Syntactically invalid YAML between fences → whole source is body.
//   - Valid YAML that isn't a mapping → whole source is body.
//   - Valid YAML mapping → frontmatter map + body after the close.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type FrontmatterMap = Record<string, unknown>;

export type ParsedDocument = {
  /** Always an object — non-mapping YAML is rejected via leniency. */
  frontmatter: FrontmatterMap;
  /** Markdown body with the frontmatter block removed. */
  body: string;
};

/** Split a Markdown source into its frontmatter map + body. */
export function parse(source: string): ParsedDocument {
  const stripped = stripOpeningFence(source);
  if (stripped === null) {
    return { frontmatter: {}, body: source };
  }
  const split = splitAtClosingFence(stripped);
  if (split === null) {
    // Opening fence, no closing fence — almost certainly a `---` that's
    // intended as a horizontal rule and just happens to be at byte zero.
    return { frontmatter: {}, body: source };
  }
  const [yaml, body] = split;
  if (yaml.trim().length === 0) {
    return { frontmatter: {}, body };
  }

  let value: unknown;
  try {
    value = parseYaml(yaml);
  } catch {
    return { frontmatter: {}, body: source };
  }

  if (value === null || value === undefined) {
    // `---\n\n---\n` parses to null in YAML; treat as empty map.
    return { frontmatter: {}, body };
  }

  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    // Scalar or sequence at the top level — fall back to whole-source-as-body.
    return { frontmatter: {}, body: source };
  }

  return { frontmatter: value as FrontmatterMap, body };
}

/**
 * Render a frontmatter map as a YAML block fenced by `---` lines, suitable
 * for prepending to a Markdown body. Returns the empty string when the map
 * is empty so callers can unconditionally concatenate `serialize(fm) + body`
 * and get a clean file either way.
 */
export function serialize(frontmatter: FrontmatterMap): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return '';
  // `yaml`'s `stringify` always terminates each line with '\n'.
  const yaml = stringifyYaml(frontmatter);
  const trailing = yaml.endsWith('\n') ? '' : '\n';
  return `---\n${yaml}${trailing}---\n`;
}

/**
 * Quick test for "this body might have a leading frontmatter block."
 * Parsing is cheap but the renderer calls this on every save to decide
 * whether to attempt the leading-fm absorption path; skipping the
 * obvious-no cases keeps the hot path tight.
 */
export function mightHaveLeadingFrontmatter(body: string): boolean {
  return body.startsWith('---\n') || body.startsWith('---\r\n');
}

function stripOpeningFence(source: string): string | null {
  if (!source.startsWith('---')) return null;
  const after = source.slice(3);
  if (after.startsWith('\n')) return after.slice(1);
  if (after.startsWith('\r\n')) return after.slice(2);
  return null;
}

function splitAtClosingFence(rest: string): [string, string] | null {
  let offset = 0;
  // split() loses the line separator; we need it for offset bookkeeping.
  const len = rest.length;
  let lineStart = 0;
  for (let i = 0; i <= len; i++) {
    const c = i < len ? rest.charCodeAt(i) : -1;
    if (c === 10 /* \n */ || i === len) {
      const lineEndExclusive = i;
      let trimEnd = lineEndExclusive;
      // Trim CR if present.
      if (trimEnd > lineStart && rest.charCodeAt(trimEnd - 1) === 13 /* \r */) {
        trimEnd -= 1;
      }
      const trimmed = rest.slice(lineStart, trimEnd);
      if (trimmed === '---' || trimmed === '...') {
        const yaml = rest.slice(0, lineStart);
        // Skip the closing fence line (including the trailing newline if any).
        const bodyStart = i < len ? i + 1 : len;
        const body = rest.slice(bodyStart);
        return [yaml, body];
      }
      lineStart = i + 1;
      offset = lineStart;
    }
  }
  void offset;
  return null;
}

// ============================ Project schema ============================

export type FieldInfo = {
  /** Number of files in the project that have this field at all. */
  presence: number;
  /** Distinct value-type names seen across files. JSON-style names:
   *  "string" | "number" | "boolean" | "null" | "array" | "object". Sorted. */
  types: string[];
  /**
   * Distinct scalar values seen across files, in insertion order.
   * Populated only when every value is scalar (string / number / boolean /
   * null) AND the distinct count is ≤ 20. Larger sets and any field that
   * ever saw a non-scalar value have an empty `knownValues`, which the
   * autocomplete layer interprets as "no suggestions to offer here."
   */
  knownValues: unknown[];
};

export type ProjectSchema = {
  fileCount: number;
  fields: Record<string, FieldInfo>;
};

const KNOWN_VALUES_THRESHOLD = 20;

/**
 * Infer a project-wide frontmatter schema from a parsed file list. Linear
 * in total field count across the project; cheap enough to run inline
 * during the project scan and again on every manifest refresh.
 */
export function inferSchema(
  files: Array<{ frontmatter: FrontmatterMap }>
): ProjectSchema {
  type Accum = {
    presence: number;
    types: string[];
    knownValues: unknown[];
    abandoned: boolean;
  };

  const fields = new Map<string, Accum>();

  for (const file of files) {
    for (const [key, value] of Object.entries(file.frontmatter)) {
      let entry = fields.get(key);
      if (!entry) {
        entry = { presence: 0, types: [], knownValues: [], abandoned: false };
        fields.set(key, entry);
      }
      entry.presence += 1;

      const t = valueTypeName(value);
      if (!entry.types.includes(t)) entry.types.push(t);

      if (entry.abandoned) continue;
      if (!isScalar(value)) {
        entry.knownValues = [];
        entry.abandoned = true;
        continue;
      }
      if (!entry.knownValues.some((v) => deepEqual(v, value))) {
        entry.knownValues.push(value);
        if (entry.knownValues.length > KNOWN_VALUES_THRESHOLD) {
          entry.knownValues = [];
          entry.abandoned = true;
        }
      }
    }
  }

  // Emit fields in alphabetical key order so the wire output is stable
  // regardless of file walk order.
  const out: Record<string, FieldInfo> = {};
  const keys = Array.from(fields.keys()).sort();
  for (const k of keys) {
    const a = fields.get(k)!;
    out[k] = {
      presence: a.presence,
      types: a.types.slice().sort(),
      knownValues: a.knownValues
    };
  }

  return { fileCount: files.length, fields: out };
}

export function valueTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

function isScalar(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}
