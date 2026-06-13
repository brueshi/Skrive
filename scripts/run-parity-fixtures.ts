// Replay the parity corpus against a dispatcher and diff normalized
// responses. Default dispatcher is the in-process Electron-shell handlers
// (electron stubbed via the preload); a foreign dispatcher (the Zig core)
// is driven over stdin/stdout with `--exec "<command>"`, one request
// JSON per line in, one response JSON per line out.
//
// Run with:  bun --preload ./scripts/parity/preload.ts \
//                ./scripts/run-parity-fixtures.ts [--exec "<cmd>"]
// (or `bun run parity:check`).

import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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

type Dispatcher = {
  dispatch: (request: string) => Promise<string>;
  close?: () => void;
};

/** Line-oriented subprocess dispatcher for a foreign core (Zig harness):
 *  write one request line, read one response line. Requests must not
 *  contain raw newlines — every corpus request is single-line JSON or a
 *  sentinel, so this holds. */
function execDispatcher(command: string): Dispatcher {
  const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = createInterface({ input: child.stdout });
  const queue: Array<(line: string) => void> = [];
  rl.on('line', (line) => queue.shift()?.(line));
  return {
    dispatch: (request: string) =>
      new Promise<string>((resolve) => {
        queue.push(resolve);
        child.stdin.write(request.replace(/\n/g, ' ') + '\n');
      }),
    close: () => child.kill()
  };
}

function parseArgs(): { exec: string | null } {
  const i = process.argv.indexOf('--exec');
  return { exec: i !== -1 ? (process.argv[i + 1] ?? null) : null };
}

async function main(): Promise<void> {
  const { exec } = parseArgs();
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'skrive-parity-run-'));
  cpSync(sampleProject, tempRoot, { recursive: true });
  const roots = [tempRoot, realpathSync(tempRoot)];

  const dispatcher: Dispatcher = exec
    ? execDispatcher(exec)
    : { dispatch: inProcessDispatcher() };

  type Mismatch = { namespace: string; name: string; expected: string; got: string };
  const mismatches: Mismatch[] = [];
  let total = 0;

  try {
    for (const group of groups()) {
      const file = path.join(fixturesDir, `${group.namespace}.jsonl`);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const fixture = JSON.parse(line) as {
          name: string;
          request: string;
          response: string;
        };
        const request = expandRequest(withRoot(fixture.request, tempRoot));
        const got = normalize(await dispatcher.dispatch(request), roots);
        total++;
        if (got !== fixture.response) {
          mismatches.push({
            namespace: group.namespace,
            name: fixture.name,
            expected: fixture.response,
            got
          });
        }
      }
    }
  } finally {
    dispatcher.close?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  if (mismatches.length === 0) {
    console.log(`Parity corpus green: ${total}/${total} fixtures match.`);
    return;
  }
  console.error(`Parity corpus FAILED: ${mismatches.length}/${total} mismatched.`);
  for (const m of mismatches) {
    console.error(`\n  [${m.namespace}] ${m.name}`);
    console.error(`    expected: ${m.expected}`);
    console.error(`    got:      ${m.got}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
