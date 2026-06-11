import { computeDiff, computeLineDiff } from '@skrive/diff';
import type { DiffOp, LineDiffRow } from '@skrive/shared';
import { IpcError, registerCommand } from '../main/dispatch';

// `@skrive/diff` returns serde_json::Value trees from napi. The Rust
// side documents the camelCase shape and `native/diff/__test__`
// gates parity, so the casts below are safe under test.

function requireStrings(payload: Record<string, unknown>): {
  before: string;
  after: string;
} {
  const { before, after } = payload;
  if (typeof before !== 'string' || typeof after !== 'string') {
    throw new IpcError('INVALID_PAYLOAD', 'before and after must be strings');
  }
  return { before, after };
}

export function registerDiffHandlers(): void {
  registerCommand('diff:computeDiff', (payload) => {
    const { before, after } = requireStrings(payload);
    return { ops: computeDiff(before, after) as DiffOp[] };
  });
  registerCommand('diff:computeLineDiff', (payload) => {
    const { before, after } = requireStrings(payload);
    return { rows: computeLineDiff(before, after) as LineDiffRow[] };
  });
}
