// missing_required_frontmatter — flag every file that doesn't declare
// every field listed in `[lint.required_frontmatter].fields`. Single-file
// scope; reads `ctx.frontmatter` (precomputed during the project scan)
// and `ctx.fullConfig.lint.requiredFrontmatter.fields`.
//
// Per `docs/skrive-toml-reference.md`: when the configured field list
// is empty, the rule is silently a no-op even if its severity isn't
// 'off'. (That keeps the default config — empty list, severity 'warn' —
// from spamming every file with warnings.)

import type { LintFinding } from '@skrive/shared';
import type { FileLintContext, FileRule } from '../types';

export const missingRequiredFrontmatterRule: FileRule = {
  id: 'missing_required_frontmatter',
  scope: 'file',
  defaultSeverity: 'warn',
  run(ctx: FileLintContext, severity): LintFinding[] {
    const required = ctx.fullConfig.lint.requiredFrontmatter.fields;
    if (required.length === 0) return [];

    const missing = required.filter(
      (field) => !Object.prototype.hasOwnProperty.call(ctx.frontmatter, field)
    );
    if (missing.length === 0) return [];

    const formatted =
      missing.length === 1
        ? `\`${missing[0]}\``
        : `\`${missing.slice(0, -1).join('`, `')}\` and \`${missing[missing.length - 1]}\``;

    return [
      {
        rule: 'missing_required_frontmatter',
        severity,
        path: ctx.path,
        line: 1,
        column: 1,
        range: null,
        message: `Missing required frontmatter: ${formatted}.`
      }
    ];
  }
};
