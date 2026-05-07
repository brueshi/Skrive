// Lenient `.skrive.toml` parser.
//
// Behavior is documented in `docs/skrive-toml-reference.md` § Parse behavior:
// the parser never blocks project open. Syntax errors, unknown sections,
// unknown keys, and bad value types each produce a warning and a fallback
// to defaults for the offending bit. Everything else applies on top.
//
// The parser doesn't read the file — it takes the source string. The
// caller (project.ts) decides whether `.skrive.toml` is present and
// hands in `null` when it isn't.

import { parse as parseToml, TomlError } from 'smol-toml';
import {
  DEFAULT_PROJECT_CONFIG,
  LINT_RULE_TOML_KEYS,
  type LintConfig,
  type LintRuleId,
  type LintSeverity,
  type SkriveProjectConfig
} from '@skrive/shared';

const VALID_SEVERITIES: LintSeverity[] = ['error', 'warn', 'off'];
const KNOWN_TOP_LEVEL = new Set([
  'project',
  'lint',
  'dictionary',
  'export',
  'checkpoints'
]);

export type ParseResult = {
  config: SkriveProjectConfig;
  warnings: string[];
};

export function parseSkriveToml(source: string | null): ParseResult {
  if (source === null || source.trim().length === 0) {
    return { config: cloneDefault(), warnings: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(source) as Record<string, unknown>;
  } catch (err) {
    const message =
      err instanceof TomlError
        ? `.skrive.toml: parse error at line ${err.line ?? '?'} — ${err.message}`
        : `.skrive.toml: parse error — ${(err as Error).message ?? String(err)}`;
    return { config: cloneDefault(), warnings: [message] };
  }

  const warnings: string[] = [];
  const config = cloneDefault();

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      warnings.push(`.skrive.toml: unknown section [${key}] (ignored)`);
    }
  }

  if (parsed.project !== undefined) {
    applyProject(config, parsed.project, warnings);
  }
  if (parsed.lint !== undefined) {
    applyLint(config.lint, parsed.lint, warnings);
  }
  if (parsed.dictionary !== undefined) {
    applyDictionary(config, parsed.dictionary, warnings);
  }
  // [export.*] and [checkpoints] are accepted but not consumed yet.
  // Their presence is allowed without warning per the schema reference.

  return { config, warnings };
}

function applyProject(
  config: SkriveProjectConfig,
  raw: unknown,
  warnings: string[]
): void {
  if (!isPlainObject(raw)) {
    warnings.push(
      '.skrive.toml: [project] is not a table (ignored)'
    );
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'name') {
      if (typeof value === 'string') {
        config.project.name = value;
      } else {
        warnings.push(
          `.skrive.toml: [project].name must be a string (got ${valueTypeLabel(value)}; ignored)`
        );
      }
    } else {
      warnings.push(`.skrive.toml: unknown key [project].${key} (ignored)`);
    }
  }
}

function applyLint(
  lint: LintConfig,
  raw: unknown,
  warnings: string[]
): void {
  if (!isPlainObject(raw)) {
    warnings.push('.skrive.toml: [lint] is not a table (ignored)');
    return;
  }

  for (const [tomlKey, value] of Object.entries(raw)) {
    if (tomlKey === 'required_frontmatter') {
      applyRequiredFrontmatter(lint, value, warnings);
      continue;
    }
    const ruleId = tomlKey as LintRuleId;
    const camelKey = LINT_RULE_TOML_KEYS[ruleId];
    if (!camelKey) {
      warnings.push(`.skrive.toml: unknown rule [lint].${tomlKey} (ignored)`);
      continue;
    }
    if (typeof value !== 'string' || !isValidSeverity(value)) {
      warnings.push(
        `.skrive.toml: [lint].${tomlKey} must be "error", "warn", or "off" (got ${formatScalar(value)}; using default)`
      );
      continue;
    }
    lint[camelKey] = value;
  }
}

function applyRequiredFrontmatter(
  lint: LintConfig,
  raw: unknown,
  warnings: string[]
): void {
  if (!isPlainObject(raw)) {
    warnings.push(
      '.skrive.toml: [lint.required_frontmatter] is not a table (ignored)'
    );
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fields') {
      if (!Array.isArray(value)) {
        warnings.push(
          `.skrive.toml: [lint.required_frontmatter].fields must be an array of strings (got ${valueTypeLabel(value)}; ignored)`
        );
        continue;
      }
      const fields: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          fields.push(item);
        } else {
          warnings.push(
            `.skrive.toml: [lint.required_frontmatter].fields entry must be a string (got ${valueTypeLabel(item)}; skipped)`
          );
        }
      }
      lint.requiredFrontmatter.fields = fields;
    } else {
      warnings.push(
        `.skrive.toml: unknown key [lint.required_frontmatter].${key} (ignored)`
      );
    }
  }
}

function applyDictionary(
  config: SkriveProjectConfig,
  raw: unknown,
  warnings: string[]
): void {
  if (!isPlainObject(raw)) {
    warnings.push('.skrive.toml: [dictionary] is not a table (ignored)');
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'project_words') {
      if (!Array.isArray(value)) {
        warnings.push(
          `.skrive.toml: [dictionary].project_words must be an array of strings (got ${valueTypeLabel(value)}; ignored)`
        );
        continue;
      }
      const words: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          if (trimmed.length > 0) words.push(trimmed);
        } else {
          warnings.push(
            `.skrive.toml: [dictionary].project_words entry must be a string (got ${valueTypeLabel(item)}; skipped)`
          );
        }
      }
      config.dictionary.projectWords = words;
    } else {
      warnings.push(`.skrive.toml: unknown key [dictionary].${key} (ignored)`);
    }
  }
}

function cloneDefault(): SkriveProjectConfig {
  return {
    project: { ...DEFAULT_PROJECT_CONFIG.project },
    lint: {
      ...DEFAULT_PROJECT_CONFIG.lint,
      requiredFrontmatter: {
        fields: [...DEFAULT_PROJECT_CONFIG.lint.requiredFrontmatter.fields]
      }
    },
    dictionary: {
      projectWords: [...DEFAULT_PROJECT_CONFIG.dictionary.projectWords]
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isValidSeverity(value: string): value is LintSeverity {
  return (VALID_SEVERITIES as string[]).includes(value);
}

function valueTypeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return String(value);
}
