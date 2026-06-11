// Frontmatter parser + serializer + schema inference tests.
//
// Mirrors the Rust unit tests in src-tauri/src/frontmatter.rs and
// src-tauri/src/project.rs::infer_schema. The shared TS implementation
// is the source of truth on the JS side; these tests gate the boundary
// against the algorithm's documented behavior.

import { describe, expect, it } from 'vitest';
import {
  inferSchema,
  parseFrontmatter,
  serializeFrontmatter
} from '@skrive/shared';

describe('parseFrontmatter', () => {
  it('parses simple frontmatter', () => {
    const src = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter.title).toBe('Hello');
    expect(parsed.frontmatter.tags).toEqual(['a', 'b']);
    expect(parsed.body).toBe('# Body\n');
  });

  it('returns empty map when there is no frontmatter', () => {
    const parsed = parseFrontmatter('# Just a heading\n');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('# Just a heading\n');
  });

  it('treats unterminated fence as body', () => {
    const src = '---\ntitle: oops\n# Body without closing fence\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(src);
  });

  it('handles empty frontmatter block', () => {
    const parsed = parseFrontmatter('---\n---\n# Body\n');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('# Body\n');
  });

  it('falls back to body for non-mapping fence (sequence)', () => {
    const src = '---\n- one\n- two\n---\nreal body\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(src);
  });

  it('falls back to body for malformed YAML between fences', () => {
    const src = '---\nthis: is : not : yaml\n---\nbody\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(src);
  });

  it('falls back to body for prose-between-rules', () => {
    const src = '---\nA short note from the author.\n---\n\n# The Body\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(src);
  });

  it('accepts ... as closing fence', () => {
    const src = '---\ntitle: Hello\n...\n# Body\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter.title).toBe('Hello');
    expect(parsed.body).toBe('# Body\n');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\ntitle: Hello\r\n---\r\n# Body\r\n';
    const parsed = parseFrontmatter(src);
    expect(parsed.frontmatter.title).toBe('Hello');
    expect(parsed.body).toBe('# Body\r\n');
  });
});

describe('serializeFrontmatter', () => {
  it('returns empty string for empty map', () => {
    expect(serializeFrontmatter({})).toBe('');
  });

  it('emits scalar values', () => {
    const out = serializeFrontmatter({ title: 'Hello', draft: true });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.endsWith('---\n')).toBe(true);
    expect(out).toMatch(/title: Hello/);
    expect(out).toMatch(/draft: true/);
  });

  it('emits array values in order', () => {
    const out = serializeFrontmatter({ tags: ['a', 'b'] });
    expect(out).toMatch(/tags:/);
    // Matches either flow form or block form; both are valid YAML.
    expect(out).toMatch(/a/);
    expect(out).toMatch(/b/);
    const indexA = out.indexOf('a');
    const indexB = out.indexOf('b');
    expect(indexA).toBeGreaterThan(0);
    expect(indexB).toBeGreaterThan(indexA);
  });

  it('round-trips logical content', () => {
    const original = '---\ntitle: Hello World\ntags:\n  - a\n  - b\n---\n# Body\n';
    const parsed = parseFrontmatter(original);
    const reserialized = serializeFrontmatter(parsed.frontmatter);
    const reparsed = parseFrontmatter(reserialized + parsed.body);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(reparsed.body).toBe(parsed.body);
  });
});

describe('inferSchema', () => {
  it('returns an empty schema for no files', () => {
    const schema = inferSchema([]);
    expect(schema.fileCount).toBe(0);
    expect(schema.fields).toEqual({});
  });

  it('counts presence and types', () => {
    const schema = inferSchema([
      { frontmatter: { title: 'A', draft: true } },
      { frontmatter: { title: 'B', draft: false, tags: ['x'] } },
      { frontmatter: { title: 'C' } }
    ]);
    expect(schema.fileCount).toBe(3);
    expect(schema.fields.title?.presence).toBe(3);
    expect(schema.fields.title?.types).toEqual(['string']);
    expect(schema.fields.draft?.presence).toBe(2);
    expect(schema.fields.draft?.types).toEqual(['boolean']);
    expect(schema.fields.tags?.presence).toBe(1);
    expect(schema.fields.tags?.types).toEqual(['array']);
  });

  it('captures distinct scalar known values', () => {
    const schema = inferSchema([
      { frontmatter: { status: 'draft' } },
      { frontmatter: { status: 'published' } },
      { frontmatter: { status: 'draft' } }
    ]);
    expect(schema.fields.status?.knownValues).toEqual(['draft', 'published']);
  });

  it('abandons known values when the threshold is exceeded', () => {
    const files = [];
    for (let i = 0; i < 25; i++) {
      files.push({ frontmatter: { tag: `tag-${i}` } });
    }
    const schema = inferSchema(files);
    expect(schema.fields.tag?.knownValues).toEqual([]);
  });

  it('abandons known values once a non-scalar appears', () => {
    const schema = inferSchema([
      { frontmatter: { meta: 'a' } },
      { frontmatter: { meta: { nested: true } } }
    ]);
    expect(schema.fields.meta?.knownValues).toEqual([]);
    expect(schema.fields.meta?.types.sort()).toEqual(['object', 'string']);
  });

  it('emits fields in alphabetical order', () => {
    const schema = inferSchema([
      { frontmatter: { zeta: 1, alpha: 2, mu: 3 } }
    ]);
    expect(Object.keys(schema.fields)).toEqual(['alpha', 'mu', 'zeta']);
  });
});
