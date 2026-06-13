// Generate the parity corpus: drive the real Electron-shell dispatcher
// (electron stubbed via the preload) over a fresh copy of the sample
// project, capturing one normalized { name, request, response } line per
// command into shell-zig/fixtures/<namespace>.jsonl.
//
// Run with:  bun --preload ./scripts/parity/preload.ts \
//                ./scripts/generate-parity-fixtures.ts
// (or `bun run parity:gen`).

import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandRequest,
  groups,
  inProcessDispatcher,
  normalize,
  withRoot
} from './parity/corpus';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sampleProject = path.join(repoRoot, 'shell-zig/fixtures/sample-project');
const fixturesDir = path.join(repoRoot, 'shell-zig/fixtures');

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'skrive-parity-gen-'));
  cpSync(sampleProject, tempRoot, { recursive: true });
  const roots = [tempRoot, realpathSync(tempRoot)];
  const dispatch = inProcessDispatcher();

  let count = 0;
  try {
    for (const group of groups()) {
      const lines: string[] = [];
      for (const spec of group.specs) {
        const request = expandRequest(withRoot(spec.request, tempRoot));
        const response = await dispatch(request);
        lines.push(
          JSON.stringify({
            name: spec.name,
            request: spec.request,
            response: normalize(response, roots)
          })
        );
        count++;
      }
      const file = path.join(fixturesDir, `${group.namespace}.jsonl`);
      writeFileSync(file, lines.join('\n') + '\n', 'utf8');
      console.log(`  ${group.namespace}.jsonl  (${group.specs.length} cases)`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`Wrote ${count} fixtures to shell-zig/fixtures/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
