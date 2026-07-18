// Tolerant `.folio` reader (SKR-195, spec §1, §11). It preserves unknown docMeta
// keys across a round trip, and it REFUSES FORWARD — never partial-parses — when
// it meets a file it cannot fully understand: a `schemaVersion` it does not know,
// or a zip container (`PK` magic) that is the reserved v2 embedded-media form.
//
// Version detection is by the first non-whitespace byte (spec §1): `{` -> JSON v1;
// `PK` (0x50 0x4B) -> a v2 zip. A malformed v1 file (bad JSON, a wrong-shaped
// block, a missing required field) is a hard parse error, not a partial read — a
// half-parsed rich document is worse than a clear refusal.

import { FOLIO_SCHEMA_VERSION } from './types';
import type {
  FolioAlign,
  FolioBlock,
  FolioDocument,
  FolioInline,
  FolioListItem,
  FolioMarks,
  FolioMeta
} from './types';

/** The file is a form this reader cannot read forward-compatibly (a newer
 *  `schemaVersion`, or the v2 zip container). The caller surfaces this to the user
 *  as "made by a newer Skrive" rather than corrupting or dropping content. */
export class FolioForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolioForwardError';
  }
}

/** The bytes claim to be v1 `.folio` but are malformed. Not a forward-compat
 *  situation — a genuinely broken or wrong-shaped file. */
export class FolioParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolioParseError';
  }
}

function firstNonWhitespace(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return c;
  }
  return '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new FolioParseError(`${where} must be a string`);
  return v;
}

function requireArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new FolioParseError(`${where} must be an array`);
  return v;
}

function readMarks(v: unknown, where: string): FolioMarks {
  if (v === undefined) return {};
  if (!isObject(v)) throw new FolioParseError(`${where}.marks must be an object`);
  const marks: FolioMarks = {};
  if (v.em === true) marks.em = true;
  if (v.strong === true) marks.strong = true;
  if (v.code === true) marks.code = true;
  if (v.strikethrough === true) marks.strikethrough = true;
  if (v.underline === true) marks.underline = true;
  if (v.link !== undefined) {
    if (!isObject(v.link)) throw new FolioParseError(`${where}.marks.link must be an object`);
    marks.link = {
      href: requireString(v.link.href, `${where}.marks.link.href`),
      title: v.link.title == null ? null : requireString(v.link.title, `${where}.marks.link.title`)
    };
  }
  return marks;
}

function readInline(v: unknown, where: string): FolioInline {
  if (!isObject(v)) throw new FolioParseError(`${where} must be an object`);
  const marks = readMarks(v.marks, where);
  switch (v.kind) {
    case 'text':
      return { kind: 'text', text: requireString(v.text, `${where}.text`), marks };
    case 'tag':
      return { kind: 'tag', name: requireString(v.name, `${where}.name`), marks };
    case 'image':
      return {
        kind: 'image',
        url: requireString(v.url, `${where}.url`),
        alt: requireString(v.alt, `${where}.alt`),
        title: v.title == null ? null : requireString(v.title, `${where}.title`),
        marks
      };
    case 'break':
      return { kind: 'break', marks };
    case 'footnote_ref':
      return { kind: 'footnote_ref', label: requireString(v.label, `${where}.label`), marks };
    default:
      throw new FolioParseError(`${where}.kind is not a known inline kind: ${String(v.kind)}`);
  }
}

function readInlineArray(v: unknown, where: string): FolioInline[] {
  return requireArray(v, where).map((n, i) => readInline(n, `${where}[${i}]`));
}

function requireInteger(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new FolioParseError(`${where} must be an integer`);
  }
  return v;
}

function requireBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new FolioParseError(`${where} must be a boolean`);
  return v;
}

function readAlign(v: unknown, where: string): FolioAlign {
  if (v === null) return null;
  if (v === 'left' || v === 'right' || v === 'center') return v;
  throw new FolioParseError(`${where} is not a valid alignment: ${String(v)}`);
}

function readListItem(v: unknown, where: string): FolioListItem {
  if (!isObject(v)) throw new FolioParseError(`${where} must be an object`);
  const item: FolioListItem = {
    spread: requireBoolean(v.spread, `${where}.spread`),
    children: readBlockArray(v.children, `${where}.children`)
  };
  if (v.checked !== undefined) item.checked = requireBoolean(v.checked, `${where}.checked`);
  return item;
}

function readBlock(v: unknown, where: string): FolioBlock {
  if (!isObject(v)) throw new FolioParseError(`${where} must be an object`);
  const id = requireString(v.id, `${where}.id`);
  switch (v.type) {
    case 'paragraph':
      return { id, type: 'paragraph', inline: readInlineArray(v.inline, `${where}.inline`) };
    case 'heading':
      return {
        id,
        type: 'heading',
        level: requireInteger(v.level, `${where}.level`),
        inline: readInlineArray(v.inline, `${where}.inline`)
      };
    case 'code_block':
      return {
        id,
        type: 'code_block',
        lang: requireString(v.lang, `${where}.lang`),
        meta: v.meta == null ? null : requireString(v.meta, `${where}.meta`),
        text: requireString(v.text, `${where}.text`)
      };
    case 'horizontal_rule':
      return { id, type: 'horizontal_rule' };
    case 'blockquote':
      return { id, type: 'blockquote', children: readBlockArray(v.children, `${where}.children`) };
    case 'footnote_definition':
      return {
        id,
        type: 'footnote_definition',
        label: requireString(v.label, `${where}.label`),
        children: readBlockArray(v.children, `${where}.children`)
      };
    case 'bullet_list':
      return {
        id,
        type: 'bullet_list',
        spread: requireBoolean(v.spread, `${where}.spread`),
        items: requireArray(v.items, `${where}.items`).map((it, i) =>
          readListItem(it, `${where}.items[${i}]`)
        )
      };
    case 'ordered_list':
      return {
        id,
        type: 'ordered_list',
        start: requireInteger(v.start, `${where}.start`),
        spread: requireBoolean(v.spread, `${where}.spread`),
        items: requireArray(v.items, `${where}.items`).map((it, i) =>
          readListItem(it, `${where}.items[${i}]`)
        )
      };
    case 'table':
      return {
        id,
        type: 'table',
        align: requireArray(v.align, `${where}.align`).map((a, i) =>
          readAlign(a, `${where}.align[${i}]`)
        ),
        rows: requireArray(v.rows, `${where}.rows`).map((row, r) =>
          requireArray(row, `${where}.rows[${r}]`).map((cell, c) =>
            readInlineArray(cell, `${where}.rows[${r}][${c}]`)
          )
        )
      };
    default:
      throw new FolioParseError(`${where}.type is not a known block type: ${String(v.type)}`);
  }
}

function readBlockArray(v: unknown, where: string): FolioBlock[] {
  return requireArray(v, where).map((b, i) => readBlock(b, `${where}[${i}]`));
}

// Preserve every docMeta key. title/createdAt are normalized (title -> null when
// absent); all other keys ride through verbatim in their source order so a newer
// writer's additions survive a round trip through this reader (spec §4).
function readMeta(v: unknown): FolioMeta {
  if (v === undefined) return { title: null, createdAt: '' };
  if (!isObject(v)) throw new FolioParseError('docMeta must be an object');
  const meta: FolioMeta = { ...v, title: null, createdAt: '' };
  meta.title = v.title == null ? null : requireString(v.title, 'docMeta.title');
  meta.createdAt = v.createdAt == null ? '' : requireString(v.createdAt, 'docMeta.createdAt');
  return meta;
}

/**
 * Parse `.folio` bytes into a document. Throws `FolioForwardError` for a file this
 * reader cannot read forward (newer version, or the v2 zip container) and
 * `FolioParseError` for malformed v1 bytes. Never returns a partial document.
 */
export function parseFolio(text: string): FolioDocument {
  const first = firstNonWhitespace(text);
  if (first === 'P' && firstNonWhitespace(text.replace(/^\s*P/, '')) === 'K') {
    throw new FolioForwardError(
      'This .folio is a v2 container (embedded media) that this version cannot open.'
    );
  }
  if (first !== '{') {
    throw new FolioParseError('Not a .folio document (expected a JSON object).');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new FolioParseError(`Invalid JSON: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new FolioParseError('Top level must be an object.');

  const version = raw.schemaVersion;
  if (version !== FOLIO_SCHEMA_VERSION) {
    throw new FolioForwardError(
      `Unsupported .folio schemaVersion ${String(version)}; this version reads ${FOLIO_SCHEMA_VERSION}.`
    );
  }

  return {
    schemaVersion: FOLIO_SCHEMA_VERSION,
    docId: requireString(raw.docId, 'docId'),
    docMeta: readMeta(raw.docMeta),
    blocks: readBlockArray(raw.blocks, 'blocks')
  };
}
