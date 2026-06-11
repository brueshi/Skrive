// `.skrive.toml` parser tests.
//
// The parser is documented to be lenient — every error path produces a
// warning + a fallback to defaults, never a thrown exception. These tests
// gate that contract.

import { describe, expect, it } from 'vitest';
import { DEFAULT_LINT_CONFIG } from '@skrive/shared';
import { parseSkriveToml } from '../src/skrive-toml-parse';

describe('parseSkriveToml', () => {
  it('returns defaults with no warnings when source is null', () => {
    const result = parseSkriveToml(null);
    expect(result.warnings).toEqual([]);
    expect(result.config.lint).toEqual(DEFAULT_LINT_CONFIG);
    expect(result.config.project.name).toBeNull();
    expect(result.config.dictionary.projectWords).toEqual([]);
  });

  it('returns defaults with no warnings when source is empty', () => {
    const result = parseSkriveToml('   \n  \n');
    expect(result.warnings).toEqual([]);
    expect(result.config.lint).toEqual(DEFAULT_LINT_CONFIG);
  });

  it('parses a complete valid config', () => {
    const src = `
[project]
name = "My Project"

[lint]
broken_internal_links = "error"
missing_required_frontmatter = "warn"
heading_hierarchy = "off"
orphaned_files = "warn"
duplicate_headings = "warn"

[lint.required_frontmatter]
fields = ["title", "date", "tags"]

[dictionary]
project_words = ["Skrive", "atticus"]
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings).toEqual([]);
    expect(result.config.project.name).toBe('My Project');
    expect(result.config.lint.brokenInternalLinks).toBe('error');
    expect(result.config.lint.headingHierarchy).toBe('off');
    expect(result.config.lint.orphanedFiles).toBe('warn');
    expect(result.config.lint.requiredFrontmatter.fields).toEqual([
      'title',
      'date',
      'tags'
    ]);
    expect(result.config.dictionary.projectWords).toEqual([
      'Skrive',
      'atticus'
    ]);
  });

  it('preserves per-rule defaults when only some keys are set', () => {
    const src = `
[lint]
broken_internal_links = "warn"
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings).toEqual([]);
    expect(result.config.lint.brokenInternalLinks).toBe('warn');
    expect(result.config.lint.missingRequiredFrontmatter).toBe(
      DEFAULT_LINT_CONFIG.missingRequiredFrontmatter
    );
    expect(result.config.lint.headingHierarchy).toBe(
      DEFAULT_LINT_CONFIG.headingHierarchy
    );
    expect(result.config.lint.orphanedFiles).toBe(
      DEFAULT_LINT_CONFIG.orphanedFiles
    );
    expect(result.config.lint.duplicateHeadings).toBe(
      DEFAULT_LINT_CONFIG.duplicateHeadings
    );
  });

  it('falls back to defaults on syntax error and produces a warning', () => {
    const src = '[lint\nbroken_internal_links = "error"';
    const result = parseSkriveToml(src);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/parse error/);
    expect(result.config.lint).toEqual(DEFAULT_LINT_CONFIG);
  });

  it('warns on unknown top-level section but accepts everything else', () => {
    const src = `
[unknown_section]
foo = "bar"

[lint]
broken_internal_links = "warn"
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings.some((w) => w.includes('[unknown_section]'))).toBe(
      true
    );
    expect(result.config.lint.brokenInternalLinks).toBe('warn');
  });

  it('warns on unknown rule key inside [lint]', () => {
    const src = `
[lint]
no_such_rule = "warn"
broken_internal_links = "off"
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings.some((w) => w.includes('no_such_rule'))).toBe(true);
    expect(result.config.lint.brokenInternalLinks).toBe('off');
  });

  it('warns on bad severity value and uses default', () => {
    const src = `
[lint]
broken_internal_links = "panic"
    `;
    const result = parseSkriveToml(src);
    expect(
      result.warnings.some((w) => w.includes('broken_internal_links'))
    ).toBe(true);
    expect(result.config.lint.brokenInternalLinks).toBe(
      DEFAULT_LINT_CONFIG.brokenInternalLinks
    );
  });

  it('warns when severity is the wrong type', () => {
    const src = `
[lint]
broken_internal_links = 42
    `;
    const result = parseSkriveToml(src);
    expect(
      result.warnings.some((w) => w.includes('broken_internal_links'))
    ).toBe(true);
    expect(result.config.lint.brokenInternalLinks).toBe(
      DEFAULT_LINT_CONFIG.brokenInternalLinks
    );
  });

  it('skips non-string entries in required_frontmatter.fields', () => {
    const src = `
[lint.required_frontmatter]
fields = ["title", 42, "date"]
    `;
    const result = parseSkriveToml(src);
    expect(result.config.lint.requiredFrontmatter.fields).toEqual([
      'title',
      'date'
    ]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns when required_frontmatter.fields is the wrong type', () => {
    const src = `
[lint.required_frontmatter]
fields = "title"
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings.some((w) => w.includes('fields'))).toBe(true);
    expect(result.config.lint.requiredFrontmatter.fields).toEqual([]);
  });

  it('trims dictionary words and drops empties', () => {
    const src = `
[dictionary]
project_words = [" Skrive ", "", "  ", "atticus"]
    `;
    const result = parseSkriveToml(src);
    expect(result.config.dictionary.projectWords).toEqual([
      'Skrive',
      'atticus'
    ]);
  });

  it('accepts [export.*] without consuming and parses [checkpoints]', () => {
    const src = `
[export.astro]
target_dir = "../site/src/content"

[checkpoints]
auto_cap = 25
manual_cap = 10
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings).toEqual([]);
    expect(result.config.checkpoints.autoCap).toBe(25);
    expect(result.config.checkpoints.manualCap).toBe(10);
  });

  it('warns when [checkpoints] keys are not non-negative integers', () => {
    const src = `
[checkpoints]
auto_cap = "fifty"
manual_cap = -1
    `;
    const result = parseSkriveToml(src);
    expect(result.warnings.length).toBe(2);
    expect(result.config.checkpoints.autoCap).toBe(50);
    expect(result.config.checkpoints.manualCap).toBe(0);
  });
});
