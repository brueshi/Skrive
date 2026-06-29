// The mounted block surface's MenuController, registered here the same single-
// slot way as the flush hook (only one editor is mounted at a time — App keys it
// by the active tab and renders the raw source view or nothing otherwise). Lets
// command sources that live outside the editor tree — the ⌘⇧P palette's Insert
// group and the link command — drive block conversions and the link affordance
// without threading the controller through React.
//
// null whenever the block surface isn't mounted: the raw source view is showing,
// a diff is open, or no document is open. Commands gate on that, so they no-op
// (and hide from the palette) exactly when there's no surface to act on.

import type { MenuController } from './menus/controller';

let active: MenuController | null = null;
const listeners = new Set<() => void>();

export function setActiveBlockMenu(controller: MenuController | null): void {
  if (active === controller) return;
  active = controller;
  for (const listener of listeners) listener();
}

/** The mounted block surface's controller, or null when none is mounted. */
export function getActiveBlockMenu(): MenuController | null {
  return active;
}

/**
 * Subscribe to mount/unmount of the active block surface. Lets chrome that
 * lives outside the editor tree — the persistent editor toolbar band — render
 * the formatting toolbar reactively as surfaces come and go (rendered vs source
 * view, file switches), without threading the controller through React. Pairs
 * with getActiveBlockMenu as a useSyncExternalStore source.
 */
export function subscribeActiveBlockMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
