// Bridge between Skrive's lint findings and CodeMirror's @codemirror/lint
// gutter + tooltip surface. The engine runs centrally (project-wide, in
// the store) — this extension just translates `LintFinding[]` filtered
// to the active file into CM6 `Diagnostic[]`.

import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LintFinding } from '@skrive/shared';

/**
 * Build the lint extension. The supplied callback is invoked every
 * time CM6 asks for a fresh lint pass; it should return findings
 * already filtered to the active file.
 *
 * `delay: 0` keeps the markers in sync with the engine — Skrive's lint
 * runs on save / open / watcher events, not per-keystroke, so there's
 * no need for CM6's debounce.
 */
export function skriveLintExtension(
  getFindings: () => LintFinding[]
): Extension[] {
  const source = (view: EditorView): Diagnostic[] => {
    const doc = view.state.doc;
    return getFindings().map((finding) => toDiagnostic(finding, doc));
  };

  return [linter(source, { delay: 0 }), lintGutter()];
}

type DocLike = {
  length: number;
  line(n: number): { from: number; to: number; text: string };
  lines: number;
};

function toDiagnostic(finding: LintFinding, doc: DocLike): Diagnostic {
  const { from, to } = resolveRange(finding, doc);
  return {
    from,
    to,
    severity: finding.severity === 'error' ? 'error' : 'warning',
    source: finding.rule,
    message: finding.message
  };
}

function resolveRange(
  finding: LintFinding,
  doc: DocLike
): { from: number; to: number } {
  if (finding.range) {
    const from = clamp(finding.range.start, 0, doc.length);
    const to = clamp(finding.range.end, from, doc.length);
    if (to > from) return { from, to };
  }
  // Fall back to the full line at finding.line (1-indexed).
  const lineNum = clamp(finding.line, 1, doc.lines);
  const line = doc.line(lineNum);
  return { from: line.from, to: line.to };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
