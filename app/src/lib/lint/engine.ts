// Lint engine. Runs the rule registry against a project snapshot or a
// single file. Output-pure — no IPC, no React; same inputs yield the same
// report. The store is responsible for assembling the inputs (manifest,
// deadLinks, orphans, bodies) and shuttling the report to consumers.
//
// Internally it memoizes parsed ASTs across calls (see `astCache`). The engine
// is re-run on every editing pause, but typically only one file's body changed;
// without the memo, all N files re-parse each pass, which was the dominant lint
// cost (≈5ms × N). The memo makes a pass re-parse only the file that changed.

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

  // Pre-parse every file's mdast once. The previous loop structure
  // re-parsed inside each rule iteration, so a project with N
  // file-scope rules and M files paid N × M parses (5 × 184 ≈ 920
  // parses on the dogfood project, ~900ms total). Caching the AST
  // here drops it to one parse per file. Skip files that have no
  // file-scope rules to run against — if every file rule is `off`,
  // we don't pay for parsing at all.
  const fileScopeActive = RULES.some(
    (r) => r.scope === 'file' && severityFor(r.id, config) !== 'off'
  );
  const fileAsts = new Map<string, MdastRoot>();
  if (fileScopeActive) {
    for (const file of manifest.files) {
      const body = bodies.get(file.path) ?? '';
      fileAsts.set(file.path, parseAstCached(file.path, body));
    }
    pruneAstCache(manifest.files);
  }

  for (const rule of RULES) {
    const severity = severityFor(rule.id, config);
    if (severity === 'off') continue;
    if (rule.scope === 'project') {
      pushAll(findings, rule.run(projectCtx, severity));
    } else {
      for (const file of manifest.files) {
        const body = bodies.get(file.path) ?? '';
        const ast = fileAsts.get(file.path)!;
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

// Path-keyed parsed-AST memo, carried across engine calls. A hit requires the
// body to be byte-identical to what was cached, so an edited file re-parses and
// an untouched one is an O(1) lookup plus a string compare — far cheaper than a
// re-parse. ASTs are treated as read-only by the rules (the per-pass `fileAsts`
// map already shares one AST across every rule), so sharing across passes is
// equally safe.
const astCache = new Map<string, { body: string; ast: MdastRoot }>();

function parseAstCached(path: string, body: string): MdastRoot {
  const hit = astCache.get(path);
  if (hit && hit.body === body) return hit.ast;
  const ast = parseAst(body);
  astCache.set(path, { body, ast });
  return ast;
}

// Drop cache entries for files that left the project, so a long session editing
// a churning file set doesn't grow the memo unbounded. Cheap-guarded: only walks
// the cache when it has outgrown the live file set.
function pruneAstCache(files: ReadonlyArray<{ path: string }>): void {
  if (astCache.size <= files.length) return;
  const live = new Set(files.map((f) => f.path));
  for (const key of astCache.keys()) {
    if (!live.has(key)) astCache.delete(key);
  }
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
