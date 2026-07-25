// Focus mode's state contract. The mode itself is transient — the interesting
// behavior is what it does to the sidebar on the way in and out, and the fact
// that a persistence write landing mid-mode must not bake the hidden rail into
// the project.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../src/stores/project';
import type { ProjectManifest } from '@skrive/shared';

const MANIFEST = {
  root: '/tmp/project',
  files: [],
  config: { project: { name: 'Test' } }
} as unknown as ProjectManifest;

beforeEach(() => {
  useProjectStore.setState({
    manifest: null,
    liveDoc: null,
    workingSet: [],
    focusMode: false,
    sidebarVisibleBeforeFocus: null,
    sidebarVisible: true
  });
});

describe('setFocusMode', () => {
  it('hides the sidebar on entry and restores it on exit', () => {
    const store = useProjectStore.getState();
    store.setFocusMode(true);
    expect(useProjectStore.getState().focusMode).toBe(true);
    expect(useProjectStore.getState().sidebarVisible).toBe(false);
    expect(useProjectStore.getState().sidebarVisibleBeforeFocus).toBe(true);

    useProjectStore.getState().setFocusMode(false);
    expect(useProjectStore.getState().focusMode).toBe(false);
    expect(useProjectStore.getState().sidebarVisible).toBe(true);
    expect(useProjectStore.getState().sidebarVisibleBeforeFocus).toBeNull();
  });

  it('leaves the sidebar hidden on exit when it was hidden on entry', () => {
    useProjectStore.setState({ sidebarVisible: false });
    useProjectStore.getState().setFocusMode(true);
    expect(useProjectStore.getState().sidebarVisibleBeforeFocus).toBe(false);

    useProjectStore.getState().setFocusMode(false);
    expect(useProjectStore.getState().sidebarVisible).toBe(false);
  });

  it('keeps the sidebar when the writer re-showed it during the mode', () => {
    useProjectStore.getState().setFocusMode(true);
    // ⌘[ stays live inside the mode — this is the writer overriding the
    // force-hide, and their later intent must survive the exit.
    useProjectStore.getState().toggleSidebar();
    expect(useProjectStore.getState().sidebarVisible).toBe(true);

    useProjectStore.getState().setFocusMode(false);
    expect(useProjectStore.getState().sidebarVisible).toBe(true);
  });

  it('is idempotent — re-entering does not overwrite the remembered state', () => {
    useProjectStore.getState().setFocusMode(true);
    useProjectStore.getState().setFocusMode(true);
    expect(useProjectStore.getState().sidebarVisibleBeforeFocus).toBe(true);
  });

  it('toggles both ways', () => {
    useProjectStore.getState().toggleFocusMode();
    expect(useProjectStore.getState().focusMode).toBe(true);
    useProjectStore.getState().toggleFocusMode();
    expect(useProjectStore.getState().focusMode).toBe(false);
  });
});

describe('project-state persistence during focus mode', () => {
  it('persists the pre-focus sidebar visibility, not the forced-hidden one', async () => {
    const saveProjectState = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: unknown }).window = {
      skrive: { persistence: { saveProjectState } }
    };
    useProjectStore.setState({ manifest: MANIFEST, sidebarVisible: true });
    useProjectStore.getState().setFocusMode(true);

    await useProjectStore.getState().persistProjectStateNow();

    expect(saveProjectState).toHaveBeenCalledTimes(1);
    const [, snapshot] = saveProjectState.mock.calls[0]!;
    // Quitting from focus mode must not reopen the project without a sidebar.
    expect(snapshot.sidebar.visible).toBe(true);
  });
});
