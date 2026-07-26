// The bundled faces are a three-way lockstep: the registry entry, the
// @font-face pair in assets/fonts/fonts.css, and the files on disk. Nothing
// at runtime fails loudly when they drift — a registry entry with no
// @font-face silently renders the fallback stack, and an unreferenced file
// is dead weight nobody notices. These tests are the thing that fails.
//
// The license assertions are not bookkeeping either: OFL requires the
// license to travel with the fonts, so a family shipped without its OFL.txt
// is a licensing defect, not an untidy directory.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_FONTS,
  ROLE_FALLBACK,
  bundledFont,
  bundledFontStack
} from '../../src/lib/typography-registry';
import {
  EDITOR_FONT_PRESETS,
  isBundledFont,
  resolveEditorFontStack
} from '../../src/lib/typography';

const FONT_DIR = resolve(__dirname, '../../src/assets/fonts');
const FONT_CSS = readFileSync(resolve(FONT_DIR, 'fonts.css'), 'utf8');

/** Every `font-family:` value declared by an @font-face block. */
const declaredFamilies = new Set(
  [...FONT_CSS.matchAll(/@font-face\s*\{[^}]*\}/g)].flatMap((block) => {
    const m = /font-family:\s*'([^']+)'/.exec(block[0]);
    return m?.[1] ? [m[1]] : [];
  })
);

/** Every `url(...)` the stylesheet points at, relative to the font dir. */
const referencedFiles = new Set(
  [...FONT_CSS.matchAll(/url\(\s*'\.\/([^']+)'\s*\)/g)].flatMap((m) =>
    m[1] ? [m[1]] : []
  )
);

describe('bundled font registry', () => {
  // The checks below that iterate the parsed sets would pass vacuously if
  // either regex stopped matching, so assert the parse itself first.
  it('parses the stylesheet it is asserting against', () => {
    expect(declaredFamilies.size).toBe(BUNDLED_FONTS.length);
    expect(referencedFiles.size).toBeGreaterThanOrEqual(
      BUNDLED_FONTS.length
    );
  });

  it('declares an @font-face for every registered family', () => {
    for (const font of BUNDLED_FONTS) {
      expect(
        declaredFamilies.has(font.cssFamily),
        `${font.label} is registered as "${font.cssFamily}" but no @font-face declares it`
      ).toBe(true);
    }
  });

  it('registers every family the stylesheet declares', () => {
    const registered = new Set(BUNDLED_FONTS.map((f) => f.cssFamily));
    for (const family of declaredFamilies) {
      expect(
        registered.has(family),
        `fonts.css declares "${family}" but no registry entry uses it`
      ).toBe(true);
    }
  });

  it('points every url() at a file that exists', () => {
    for (const rel of referencedFiles) {
      expect(
        existsSync(resolve(FONT_DIR, rel)),
        `fonts.css references ${rel}, which is not on disk`
      ).toBe(true);
    }
  });

  it('references every shipped font file', () => {
    const onDisk = readdirSync(FONT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((dir) =>
        readdirSync(resolve(FONT_DIR, dir.name))
          .filter((f) => f.endsWith('.woff2'))
          .map((f) => `${dir.name}/${f}`)
      );
    expect(onDisk.length).toBeGreaterThan(0);
    for (const rel of onDisk) {
      expect(
        referencedFiles.has(rel),
        `${rel} ships but no @font-face loads it`
      ).toBe(true);
    }
  });

  it('ships a license beside every family', () => {
    const dirs = new Set([...referencedFiles].map((r) => r.split('/')[0]));
    for (const dir of dirs) {
      expect(
        existsSync(resolve(FONT_DIR, String(dir), 'OFL.txt')),
        `${dir} ships font files without its OFL.txt`
      ).toBe(true);
    }
  });

  it('credits every family', () => {
    for (const font of BUNDLED_FONTS) {
      expect(font.credit.length, `${font.label} has no credit`).toBeGreaterThan(
        0
      );
      expect(font.subtext.length).toBeGreaterThan(0);
    }
  });

  it('uses a unique id and label per family', () => {
    expect(new Set(BUNDLED_FONTS.map((f) => f.id)).size).toBe(
      BUNDLED_FONTS.length
    );
    expect(new Set(BUNDLED_FONTS.map((f) => f.label)).size).toBe(
      BUNDLED_FONTS.length
    );
  });
});

describe('bundled font stacks', () => {
  it('puts the family first and the role fallback behind it', () => {
    const literata = bundledFont('literata');
    expect(literata).toBeDefined();
    expect(bundledFontStack(literata!)).toBe(
      `"Literata", ${ROLE_FALLBACK.serif}`
    );
  });

  it('resolves a bundled id through the preset table', () => {
    for (const font of BUNDLED_FONTS) {
      const stack = resolveEditorFontStack(font.id, '');
      expect(stack.startsWith(`"${font.cssFamily}"`)).toBe(true);
      expect(stack).toContain(ROLE_FALLBACK[font.role]);
    }
  });

  it('separates bundled faces from system stacks', () => {
    for (const font of BUNDLED_FONTS) expect(isBundledFont(font.id)).toBe(true);
    for (const id of ['editorial', 'classic', 'screen', 'custom'] as const) {
      expect(isBundledFont(id)).toBe(false);
    }
  });

  it('offers every bundled face in the picker, grouped', () => {
    for (const font of BUNDLED_FONTS) {
      const preset = EDITOR_FONT_PRESETS.find((p) => p.id === font.id);
      expect(preset, `${font.label} is missing from the picker`).toBeDefined();
      expect(preset?.group).not.toBe('System');
    }
  });
});
