import { ipcMain } from 'electron';
import { computeDiff, computeLineDiff } from '@skrive/diff';
import type { DiffOp, LineDiffRow } from '@skrive/shared';

// `@skrive/diff` returns serde_json::Value trees from napi. The Rust
// side documents the camelCase shape and `native/diff/__test__`
// gates parity, so the casts below are safe under test.

export function registerDiffHandlers(): void {
  ipcMain.handle('diff:computeDiff', (_event, before: string, after: string) => {
    return computeDiff(before, after) as DiffOp[];
  });
  ipcMain.handle(
    'diff:computeLineDiff',
    (_event, before: string, after: string) => {
      return computeLineDiff(before, after) as LineDiffRow[];
    }
  );
}
