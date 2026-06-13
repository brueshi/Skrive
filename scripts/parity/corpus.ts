// The parity corpus: the ordered request groups, the normalization that
// makes responses machine-independent, and the in-process dispatcher
// that drives the real shell handlers (electron stubbed via preload).
//
// Determinism contract — a fixture must be reproducible on any machine
// and matchable against a foreign (Zig) dispatcher:
//   - The project root is an absolute temp path, different every run, so
//     both requests and responses store it as ROOT_TOKEN and the
//     generator/runner substitutes a real root at the edges.
//   - `*Ms` fields (mtimes, timestamps) are normalized to 0.
//   - error `message` text is human prose that legitimately differs
//     across implementations, so parity is on `code`; the message is
//     normalized to a placeholder.
//   - content hashes (SHA-256) ARE kept — they are the strong
//     cross-implementation signal that two cores read/wrote byte-equal.

import { MAX_REQUEST_BYTES } from '@skrive/shared';
import { dispatchJson } from '../../shell/src/main/dispatch';
import { registerFsHandlers } from '../../shell/src/ipc/fs';
import { registerProjectHandlers } from '../../shell/src/ipc/project';
import { registerPersistenceHandlers } from '../../shell/src/ipc/persistence';

export const ROOT_TOKEN = '__SKRIVE_ROOT__';
/** A request that must exceed MAX_REQUEST_BYTES — too large to store
 *  literally, so the fixture carries this sentinel and the edges expand
 *  it to a real oversize string at dispatch time. */
export const OVERSIZE_SENTINEL = '__SKRIVE_OVERSIZE__';

let handlersReady = false;
export function ensureHandlers(): void {
  if (handlersReady) return;
  registerFsHandlers();
  registerProjectHandlers();
  registerPersistenceHandlers();
  handlersReady = true;
}

export type Spec = { name: string; request: string };
export type Group = { namespace: string; specs: Spec[] };

const req = (id: number, cmd: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, id, cmd, payload });

// A tiny base64 payload for the binary-write command.
const PIXEL_B64 = Buffer.from('parity-pixel').toString('base64');

/** The corpus, grouped by namespace. Generator and runner BOTH iterate
 *  groups in this exact order and specs in array order, so the stateful
 *  fs/project sequences reproduce identically. Namespaces are mutually
 *  independent (distinct files / distinct storage), so grouping does not
 *  perturb state. */
export function groups(): Group[] {
  let id = 0;
  const next = () => ++id;
  return [
    {
      namespace: 'envelope',
      specs: [
        { name: 'malformed-json', request: '{ not json' },
        {
          name: 'unknown-top-level-field',
          request: JSON.stringify({
            v: 1,
            id: next(),
            cmd: 'fs:readFile',
            payload: {},
            extra: 1
          })
        },
        {
          name: 'bad-version',
          request: JSON.stringify({ v: 2, id: next(), cmd: 'app:version', payload: {} })
        },
        {
          name: 'non-object-payload',
          request: JSON.stringify({ v: 1, id: next(), cmd: 'fs:readFile', payload: 'scalar' })
        },
        { name: 'unknown-command', request: req(next(), 'nope:never', {}) },
        { name: 'payload-too-large', request: OVERSIZE_SENTINEL }
      ]
    },
    {
      namespace: 'fs',
      specs: [
        { name: 'readFile-root', request: req(next(), 'fs:readFile', { projectRoot: ROOT_TOKEN, relPath: 'README.md' }) },
        { name: 'readFile-nested', request: req(next(), 'fs:readFile', { projectRoot: ROOT_TOKEN, relPath: 'notes/intro.md' }) },
        { name: 'detectExternalChange-stale', request: req(next(), 'fs:detectExternalChange', { projectRoot: ROOT_TOKEN, relPath: 'README.md', knownHash: 'deadbeef' }) },
        { name: 'writeFile-new', request: req(next(), 'fs:writeFile', { projectRoot: ROOT_TOKEN, relPath: 'draft.md', content: '# Draft\n\nbody\n' }) },
        { name: 'newFile-fresh', request: req(next(), 'fs:newFile', { projectRoot: ROOT_TOKEN, relPath: 'fresh.md' }) },
        { name: 'newFile-exists', request: req(next(), 'fs:newFile', { projectRoot: ROOT_TOKEN, relPath: 'README.md' }) },
        { name: 'mkdir', request: req(next(), 'fs:mkdir', { projectRoot: ROOT_TOKEN, relPath: 'subdir' }) },
        { name: 'rename', request: req(next(), 'fs:rename', { projectRoot: ROOT_TOKEN, oldRelPath: 'draft.md', newRelPath: 'renamed.md' }) },
        { name: 'writeBinaryFile', request: req(next(), 'fs:writeBinaryFile', { projectRoot: ROOT_TOKEN, relPath: 'assets/pixel.bin', base64: PIXEL_B64 }) },
        { name: 'trash', request: req(next(), 'fs:trash', { projectRoot: ROOT_TOKEN, relPath: 'renamed.md' }) },
        { name: 'readFile-path-escape', request: req(next(), 'fs:readFile', { projectRoot: ROOT_TOKEN, relPath: '../escape.md' }) },
        { name: 'readFile-missing-field', request: req(next(), 'fs:readFile', { projectRoot: ROOT_TOKEN }) }
      ]
    },
    {
      namespace: 'project',
      specs: [
        { name: 'snapshot', request: req(next(), 'project:snapshot', { root: ROOT_TOKEN }) },
        { name: 'create', request: req(next(), 'project:create', { parent: ROOT_TOKEN, name: 'NewProj', gitInit: false }) },
        { name: 'create-exists', request: req(next(), 'project:create', { parent: ROOT_TOKEN, name: 'NewProj', gitInit: false }) },
        { name: 'snapshot-missing-root', request: req(next(), 'project:snapshot', {}) }
      ]
    },
    {
      namespace: 'persistence',
      specs: [
        { name: 'loadAppState-default', request: req(next(), 'persistence:loadAppState', {}) },
        { name: 'saveAppState', request: req(next(), 'persistence:saveAppState', { state: {} }) },
        { name: 'loadProjectState-null', request: req(next(), 'persistence:loadProjectState', { projectRoot: ROOT_TOKEN }) },
        { name: 'revealUserData', request: req(next(), 'persistence:revealUserData', {}) }
      ]
    }
  ];
}

/** Expand the oversize sentinel to a real >MAX_REQUEST_BYTES string. */
export function expandRequest(request: string): string {
  if (request !== OVERSIZE_SENTINEL) return request;
  const pad = 'a'.repeat(MAX_REQUEST_BYTES + 16);
  return `{"v":1,"id":1,"cmd":"fs:readFile","payload":{"pad":"${pad}"}}`;
}

/** Replace ROOT_TOKEN with the real root in a request about to dispatch. */
export function withRoot(request: string, realRoot: string): string {
  return request.split(ROOT_TOKEN).join(realRoot);
}

/** Canonicalize a response (or token-bearing request) for storage and
 *  comparison: real roots -> ROOT_TOKEN, *Ms -> 0, error message ->
 *  placeholder. `roots` includes both the temp path and its realpath
 *  (macOS /var -> /private/var) so either form collapses to the token. */
export function normalize(jsonStr: string, roots: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Raw, non-JSON request (the malformed-envelope case) — textual sub.
    let out = jsonStr;
    for (const r of roots) out = out.split(r).join(ROOT_TOKEN);
    return out;
  }
  const subRoots = (s: string): string => {
    let out = s;
    for (const r of roots) out = out.split(r).join(ROOT_TOKEN);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k.endsWith('Ms') && typeof val === 'number') out[k] = 0;
        else if (k === 'message' && typeof val === 'string') out[k] = '<message>';
        else out[k] = walk(val);
      }
      return out;
    }
    if (typeof v === 'string') return subRoots(v);
    return v;
  };
  return JSON.stringify(walk(parsed));
}

/** The in-process dispatcher: drives the real handlers. The foreign
 *  (Zig) dispatcher will implement the same `(requestJson) => responseJson`
 *  shape over stdin/stdout (see run-parity-fixtures.ts --exec). */
export function inProcessDispatcher(): (request: string) => Promise<string> {
  ensureHandlers();
  return (request: string) => dispatchJson(request);
}
