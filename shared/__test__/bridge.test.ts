// Bridge factory tests (Stage 0.2 acceptance): every namespace of the
// SkriveIpc surface exercised against an in-memory mock transport,
// asserting command names, payload shapes, and result unwrapping. Any
// conforming transport inherits this behavior unchanged.

import { beforeEach, describe, expect, it } from 'vitest';
import { createSkriveBridge } from '../src/bridge';
import type { SkriveIpc } from '../src/ipc-contracts';
import { MockTransport } from './mock-transport';

let transport: MockTransport;
let bridge: SkriveIpc;

beforeEach(() => {
  transport = new MockTransport();
  bridge = createSkriveBridge(transport);
});

function lastCall() {
  const call = transport.calls.at(-1);
  if (!call) throw new Error('no transport call recorded');
  return call;
}

describe('app', () => {
  it('version unwraps { version }', async () => {
    transport.stub('app:version', { version: '1.0.3' });
    await expect(bridge.app.version()).resolves.toBe('1.0.3');
    expect(lastCall()).toEqual({ cmd: 'app:version', payload: {} });
  });

  it('platform unwraps { platform }', async () => {
    transport.stub('app:platform', { platform: 'darwin' });
    await expect(bridge.app.platform()).resolves.toBe('darwin');
  });

  it('onFlushBeforeQuit subscribes and unsubscribes', () => {
    let fired = 0;
    const off = bridge.app.onFlushBeforeQuit(() => {
      fired++;
    });
    transport.emit('app:flush-before-quit', {});
    expect(fired).toBe(1);
    off();
    transport.emit('app:flush-before-quit', {});
    expect(fired).toBe(1);
    expect(transport.subscriberCount('app:flush-before-quit')).toBe(0);
  });

  it('flushComplete fires the ack command without awaiting it', () => {
    bridge.app.flushComplete();
    expect(lastCall()).toEqual({ cmd: 'app:flushComplete', payload: {} });
  });
});

describe('links', () => {
  it('openExternal passes the url', async () => {
    await bridge.links.openExternal('https://skrive.md');
    expect(lastCall()).toEqual({
      cmd: 'links:openExternal',
      payload: { url: 'https://skrive.md' }
    });
  });
});

describe('project', () => {
  it('openDialog unwraps { path }, including null', async () => {
    transport.stub('project:openDialog', { path: '/p' });
    await expect(bridge.project.openDialog()).resolves.toBe('/p');
    transport.stub('project:openDialog', { path: null });
    await expect(bridge.project.openDialog()).resolves.toBeNull();
  });

  it('open passes { root } and returns the manifest flat', async () => {
    const manifest = {
      root: '/p',
      files: [],
      schema: {},
      config: {},
      warnings: []
    };
    transport.stub('project:open', manifest);
    await expect(bridge.project.open('/p')).resolves.toEqual(manifest);
    expect(lastCall()).toEqual({
      cmd: 'project:open',
      payload: { root: '/p' }
    });
  });

  it('getManifest unwraps { current }, including null', async () => {
    transport.stub('project:getManifest', { current: null });
    await expect(bridge.project.getManifest()).resolves.toBeNull();
  });

  it('watch and unwatch are void commands', async () => {
    await bridge.project.watch('/p');
    expect(lastCall()).toEqual({
      cmd: 'project:watch',
      payload: { root: '/p' }
    });
    await bridge.project.unwatch();
    expect(lastCall()).toEqual({ cmd: 'project:unwatch', payload: {} });
  });

  it('onChange delivers project:change payloads', () => {
    const seen: unknown[] = [];
    bridge.project.onChange((e) => seen.push(e));
    transport.emit('project:change', { kind: 'change', path: 'a.md' });
    expect(seen).toEqual([{ kind: 'change', path: 'a.md' }]);
  });

  it('create flattens gitInit and unwraps { path }', async () => {
    transport.stub('project:create', { path: '/parent/Novel' });
    await expect(
      bridge.project.create('/parent', 'Novel', { gitInit: true })
    ).resolves.toBe('/parent/Novel');
    expect(lastCall()).toEqual({
      cmd: 'project:create',
      payload: { parent: '/parent', name: 'Novel', gitInit: true }
    });
  });
});

describe('fs', () => {
  it('readFile passes the root/relPath pair and returns FileContent flat', async () => {
    const file = { path: 'a.md', body: '# A', modifiedMs: 1, hash: 'h' };
    transport.stub('fs:readFile', file);
    await expect(bridge.fs.readFile('/p', 'a.md')).resolves.toEqual(file);
    expect(lastCall()).toEqual({
      cmd: 'fs:readFile',
      payload: { projectRoot: '/p', relPath: 'a.md' }
    });
  });

  it('writeFile unwraps { hash }', async () => {
    transport.stub('fs:writeFile', { hash: 'abc' });
    await expect(bridge.fs.writeFile('/p', 'a.md', 'body')).resolves.toBe(
      'abc'
    );
    expect(lastCall()).toEqual({
      cmd: 'fs:writeFile',
      payload: { projectRoot: '/p', relPath: 'a.md', content: 'body' }
    });
  });

  it('detectExternalChange unwraps { changed }', async () => {
    transport.stub('fs:detectExternalChange', { changed: true });
    await expect(
      bridge.fs.detectExternalChange('/p', 'a.md', 'h')
    ).resolves.toBe(true);
    expect(lastCall().payload).toEqual({
      projectRoot: '/p',
      relPath: 'a.md',
      knownHash: 'h'
    });
  });

  it('void fs commands pass their payloads', async () => {
    await bridge.fs.writeBinaryFile('/p', 'img.png', 'AAAA');
    expect(lastCall()).toEqual({
      cmd: 'fs:writeBinaryFile',
      payload: { projectRoot: '/p', relPath: 'img.png', base64: 'AAAA' }
    });
    await bridge.fs.newFile('/p', 'b.md');
    expect(lastCall().cmd).toBe('fs:newFile');
    await bridge.fs.mkdir('/p', 'dir');
    expect(lastCall().cmd).toBe('fs:mkdir');
    await bridge.fs.rename('/p', 'a.md', 'b.md');
    expect(lastCall()).toEqual({
      cmd: 'fs:rename',
      payload: { projectRoot: '/p', oldRelPath: 'a.md', newRelPath: 'b.md' }
    });
    await bridge.fs.trash('/p', 'a.md');
    expect(lastCall().cmd).toBe('fs:trash');
  });

  it('surfaces transport errors as rejections', async () => {
    transport.stubError('fs:readFile', 'Path escapes project root: ../x');
    await expect(bridge.fs.readFile('/p', '../x')).rejects.toThrow(
      'Path escapes project root: ../x'
    );
  });
});

describe('diff', () => {
  it('computeDiff unwraps { ops }', async () => {
    transport.stub('diff:computeDiff', { ops: [{ kind: 'kept' }] });
    await expect(bridge.diff.computeDiff('a', 'b')).resolves.toEqual([
      { kind: 'kept' }
    ]);
    expect(lastCall().payload).toEqual({ before: 'a', after: 'b' });
  });

  it('computeLineDiff unwraps { rows }', async () => {
    transport.stub('diff:computeLineDiff', { rows: [] });
    await expect(bridge.diff.computeLineDiff('a', 'b')).resolves.toEqual([]);
  });
});

describe('search', () => {
  it('searchProject unwraps { hits }', async () => {
    transport.stub('search:searchProject', { hits: [] });
    await expect(
      bridge.search.searchProject('needle', { caseSensitive: false })
    ).resolves.toEqual([]);
    expect(lastCall()).toEqual({
      cmd: 'search:searchProject',
      payload: { query: 'needle', options: { caseSensitive: false } }
    });
  });
});

describe('history', () => {
  it('getMode and setGitHistoryEnabled unwrap { mode }', async () => {
    transport.stub('history:getMode', { mode: 'checkpoint' });
    await expect(bridge.history.getMode()).resolves.toBe('checkpoint');
    transport.stub('history:setGitHistoryEnabled', { mode: 'git' });
    await expect(bridge.history.setGitHistoryEnabled(true)).resolves.toBe(
      'git'
    );
    expect(lastCall().payload).toEqual({ enabled: true });
  });

  it('listForFile unwraps { entries }', async () => {
    transport.stub('history:listForFile', { entries: [] });
    await expect(bridge.history.listForFile('a.md')).resolves.toEqual([]);
  });

  it('blob and checkpoint reads unwrap { content }', async () => {
    transport.stub('history:readGitBlobAt', { content: 'old' });
    await expect(bridge.history.readGitBlobAt('a.md', 'sha1')).resolves.toBe(
      'old'
    );
    expect(lastCall().payload).toEqual({ relPath: 'a.md', sha: 'sha1' });
    transport.stub('history:readCheckpointAt', { content: 'older' });
    await expect(
      bridge.history.readCheckpointAt('a.md', 'cp-1')
    ).resolves.toBe('older');
  });

  it('createManualCheckpoint passes all fields', async () => {
    await bridge.history.createManualCheckpoint('a.md', 'pin', 'body');
    expect(lastCall()).toEqual({
      cmd: 'history:createManualCheckpoint',
      payload: { relPath: 'a.md', name: 'pin', content: 'body' }
    });
  });
});

describe('linkGraph', () => {
  it('unwraps each query result field', async () => {
    transport.stub('linkGraph:getBacklinks', { backlinks: [] });
    await expect(bridge.linkGraph.getBacklinks('a.md')).resolves.toEqual([]);
    expect(lastCall().payload).toEqual({ target: 'a.md' });

    transport.stub('linkGraph:getOutgoing', { outgoing: [] });
    await expect(bridge.linkGraph.getOutgoing('a.md')).resolves.toEqual([]);
    expect(lastCall().payload).toEqual({ source: 'a.md' });

    transport.stub('linkGraph:getDeadLinks', { deadLinks: [] });
    await expect(bridge.linkGraph.getDeadLinks()).resolves.toEqual([]);

    transport.stub('linkGraph:getOrphanedFiles', { paths: ['b.md'] });
    await expect(bridge.linkGraph.getOrphanedFiles()).resolves.toEqual([
      'b.md'
    ]);
  });

  it('rename preview and commit return their reports flat', async () => {
    const preview = {
      targetExists: false,
      references: [],
      definitionUpdates: []
    };
    transport.stub('linkGraph:previewRename', preview);
    await expect(
      bridge.linkGraph.previewRename('a.md', 'b.md')
    ).resolves.toEqual(preview);
    expect(lastCall().payload).toEqual({ oldPath: 'a.md', newPath: 'b.md' });

    const report = { filesWritten: ['c.md'], referencesUpdated: 2 };
    transport.stub('linkGraph:renameWithReferences', report);
    await expect(
      bridge.linkGraph.renameWithReferences('a.md', 'b.md')
    ).resolves.toEqual(report);
  });
});

describe('updater', () => {
  it('current returns the status flat', async () => {
    transport.stub('updater:current', { kind: 'idle' });
    await expect(bridge.updater.current()).resolves.toEqual({ kind: 'idle' });
  });

  it('check and downloadAndInstall are void commands', async () => {
    await bridge.updater.check();
    expect(lastCall().cmd).toBe('updater:check');
    await bridge.updater.downloadAndInstall();
    expect(lastCall().cmd).toBe('updater:downloadAndInstall');
  });

  it('onStatus delivers updater:status payloads', () => {
    const seen: unknown[] = [];
    const off = bridge.updater.onStatus((s) => seen.push(s));
    transport.emit('updater:status', { kind: 'checking' });
    off();
    transport.emit('updater:status', { kind: 'idle' });
    expect(seen).toEqual([{ kind: 'checking' }]);
  });
});

describe('persistence', () => {
  it('loadAppState returns state flat', async () => {
    transport.stub('persistence:loadAppState', { theme: 'overcast' });
    await expect(bridge.persistence.loadAppState()).resolves.toEqual({
      theme: 'overcast'
    });
  });

  it('saveAppState wraps the state in { state }', async () => {
    await bridge.persistence.saveAppState({ theme: 'overcast' } as never);
    expect(lastCall()).toEqual({
      cmd: 'persistence:saveAppState',
      payload: { state: { theme: 'overcast' } }
    });
  });

  it('loadProjectState unwraps { state }, including null', async () => {
    transport.stub('persistence:loadProjectState', { state: null });
    await expect(bridge.persistence.loadProjectState('/p')).resolves.toBeNull();
    expect(lastCall().payload).toEqual({ projectRoot: '/p' });
  });

  it('saveProjectState passes root and state', async () => {
    await bridge.persistence.saveProjectState('/p', { tabs: [] } as never);
    expect(lastCall()).toEqual({
      cmd: 'persistence:saveProjectState',
      payload: { projectRoot: '/p', state: { tabs: [] } }
    });
  });

  it('revealUserData is a void command', async () => {
    await bridge.persistence.revealUserData();
    expect(lastCall().cmd).toBe('persistence:revealUserData');
  });
});
