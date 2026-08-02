// Wiring for documents the OS asks Skrive to open — a Finder / Explorer
// double-click, `open -a Skrive note.md`, a file argument on launch.
//
// Two arrival paths, one handler. On a COLD LAUNCH the open reaches the host
// before the renderer exists, so the host queues it and this hook drains the
// queue once at boot (`takeOpenPaths`). While ALREADY RUNNING the open arrives
// as an `app:open-paths` event. Draining also tells the host the renderer is
// awake, so the two paths can't both deliver the same open.
//
// The interesting part is what a path resolves to: see open-external-file.ts
// for the tiering. Only the `new` tier prompts, and this hook owns that
// prompt's state so the confirm sheet can live in App's render tree.

import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from './notify';
import {
  resolveOpenTargets,
  type OpenTarget
} from './open-external-file';
import { logProjectError, useProjectStore } from '../stores/project';
import { usePreferencesStore } from '../stores/preferences';

export type OsOpenConfirmation = {
  /** Absolute folder that would become the project. */
  root: string;
  /** How many documents open once it does. */
  fileCount: number;
};

export type OsDocumentOpens = {
  /** Set when a file resolved outside every known project and the writer has
   *  to agree to its folder becoming one. Null the rest of the time. */
  confirmation: OsOpenConfirmation | null;
  confirm: () => void;
  cancel: () => void;
  /** Whether the launch-time drain has settled. The auto-open-last-project
   *  effect waits for this so the two don't both open a project. */
  launchResolved: boolean;
  /** True when a launch file is opening a project of its own, so the
   *  last-opened project must NOT also be restored over the top of it. */
  launchHandled: boolean;
};

/** Open the resolved documents, switching project first when they aren't in
 *  the one already open. */
async function openResolvedTarget(target: OpenTarget): Promise<void> {
  const store = useProjectStore.getState();
  if (target.kind !== 'current') {
    await store.openProject(target.root);
  }
  // Re-read: openProject replaced the store's actions' closure state, and it
  // restores a working set whose entry 0 would otherwise stay the live doc.
  const after = useProjectStore.getState();
  for (const relPath of target.relPaths) {
    await after.openDoc(relPath);
  }
}

export function useOsDocumentOpens(preferencesHydrated: boolean): OsDocumentOpens {
  const [confirmation, setConfirmation] = useState<OsOpenConfirmation | null>(
    null
  );
  const [launchResolved, setLaunchResolved] = useState(false);
  const [launchHandled, setLaunchHandled] = useState(false);
  // The target behind the open confirmation sheet. Held in a ref, not state:
  // it is read only by the confirm handler, and pairing it with `confirmation`
  // in one state object would let a re-render show a sheet with no target.
  const pendingRef = useRef<OpenTarget | null>(null);

  const handlePaths = useCallback((paths: string[]) => {
    const { manifest } = useProjectStore.getState();
    const { recentProjects } = usePreferencesStore.getState();
    const resolution = resolveOpenTargets(paths, {
      projectRoot: manifest?.root ?? null,
      recentRoots: recentProjects.map((entry) => entry.path)
    });

    // Never fail silently: a writer who double-clicked a file is owed an
    // answer even when the answer is no.
    for (const path of resolution.unsupported) {
      notify.warn(`Skrive can't open ${basename(path)}`);
    }
    const [firstDeferred, ...restDeferred] = resolution.deferred;
    if (firstDeferred !== undefined) {
      notify.warn(
        restDeferred.length === 0
          ? `${basename(firstDeferred)} is in another project — open that project to see it`
          : `${resolution.deferred.length} files are in other projects and didn't open`
      );
    }

    const target = resolution.target;
    if (!target) return false;

    if (target.kind === 'new') {
      pendingRef.current = target;
      setConfirmation({ root: target.root, fileCount: target.relPaths.length });
      return true;
    }

    void openResolvedTarget(target).catch((err) => {
      logProjectError('os-open', err);
      notify.error("Couldn't open the document", err);
    });
    return true;
  }, []);

  // Launch drain. Waits for preferences so the recent-projects tier is
  // populated — otherwise a file in a known project would resolve as `new` and
  // prompt for a folder the writer has already accepted.
  const drainedRef = useRef(false);
  useEffect(() => {
    if (drainedRef.current) return;
    if (!preferencesHydrated) return;
    drainedRef.current = true;
    void window.skrive.app
      .takeOpenPaths()
      .then((paths) => {
        if (paths.length > 0) setLaunchHandled(handlePaths(paths));
      })
      .catch((err) => logProjectError('os-open (launch)', err))
      .finally(() => setLaunchResolved(true));
  }, [preferencesHydrated, handlePaths]);

  // Opens while running. Subscribed unconditionally: the host only emits this
  // after the drain above, so there is no window for a duplicate delivery.
  useEffect(() => {
    return window.skrive.app.onOpenPaths((paths) => {
      handlePaths(paths);
    });
  }, [handlePaths]);

  const confirm = useCallback(() => {
    const target = pendingRef.current;
    pendingRef.current = null;
    setConfirmation(null);
    if (!target) return;
    void openResolvedTarget(target).catch((err) => {
      logProjectError('os-open (confirmed)', err);
      notify.error("Couldn't open the folder", err);
    });
  }, []);

  const cancel = useCallback(() => {
    pendingRef.current = null;
    setConfirmation(null);
  }, []);

  return { confirmation, confirm, cancel, launchResolved, launchHandled };
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
