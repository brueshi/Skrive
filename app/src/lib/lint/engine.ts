// Lint engine. Runs the rule registry against a project snapshot or a
// single file. Pure function — no IPC, no React. The store is
// responsible for assembling the inputs (manifest, deadLinks, orphans,
// bodies) and shuttling the report to consumers.

import {
  LINT_RULE_TOML_KEYS,
  type LintConfig,
  type LintFinding,
  type LintRuleId,
  type LintSeverity,
  type ProjectLintReport
} from '@skrive/shared';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root as MdastRoot } from 'mdast';
import { RULES } from './rules';
import type {
  FileLintContext,
  LintEngineInput,
  ProjectLintContext
} from './types';

export function runProjectLint(input: LintEngineInput): ProjectLintReport {
  const { manifest, bodies, deadLinks, orphanedFiles } = input;
  const config = manifest.config.lint;

  const findings: LintFinding[] = [];

  const projectCtx: ProjectLintContext = {
    manifest,
    config,
    fullConfig: manifest.config,
    deadLinks,
    orphanedFiles
  };

  for (const rule of RULES) {
    const severity = severityFor(rule.id, config);
    if (severity === 'off') continue;
    if (rule.scope === 'project') {
      pushAll(findings, rule.run(projectCtx, severity));
    } else {
      for (const file of manifest.files) {
        const body = bodies.get(file.path) ?? '';
        const ast = parseAst(body);
        const fileCtx: FileLintContext = {
          path: file.path,
          body,
          ast,
          frontmatter: file.frontmatter,
          config,
          fullConfig: manifest.config
        };
        pushAll(findings, rule.run(fileCtx, severity));
      }
    }
  }

  sortAndDedupe(findings);
  return { findings, ranAt: Date.now() };
}

export function findingsForFile(
  report: ProjectLintReport,
  path: string
): LintFinding[] {
  return report.findings.filter((finding) => finding.path === path);
}

export function severityFor(rule: LintRuleId, config: LintConfig): LintSeverity {
  const key = LINT_RULE_TOML_KEYS[rule];
  return config[key];
}

function parseAst(body: string): MdastRoot {
  return fromMarkdown(body);
}

function pushAll<T>(target: T[], source: T[]): void {
  for (const item of source) target.push(item);
}

function sortAndDedupe(findings: LintFinding[]): void {
  findings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.rule.localeCompare(b.rule);
  });

  // Defensive dedupe: stable on (rule, path, line, column, message).
  const seen = new Set<string>();
  let write = 0;
  for (let read = 0; read < findings.length; read++) {
    const f = findings[read]!;
    const key = `${f.rule}::${f.path}::${f.line}::${f.column}::${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings[write++] = f;
  }
  findings.length = write;
}
