// Bun preload for the parity scripts. Registers two virtual modules the
// runtime needs that the app's build tooling normally provides:
//   - bare `electron` -> the parity stub, so the real shell handlers load
//     outside an Electron runtime.
//   - `@skrive/shared` -> the real shared package (imported here by
//     relative path, then re-exposed under its bare name). The workspace
//     consumes shared via build-time aliases, so it is not symlinked into
//     node_modules and bun can't resolve the bare specifier at runtime.
//
// Run the corpus scripts with
//   `bun --preload ./scripts/parity/preload.ts <script>`.

import { plugin } from 'bun';
import * as electronStub from './electron-stub';
import * as skriveShared from '../../shared/src/index';

plugin({
  name: 'parity-resolvers',
  setup(build) {
    build.module('electron', () => ({
      exports: { ...electronStub },
      loader: 'object'
    }));
    build.module('@skrive/shared', () => ({
      exports: { ...skriveShared },
      loader: 'object'
    }));
  }
});
