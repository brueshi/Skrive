// The editor-agnostic menu controller (SKR-114). The shared toolbar, selection
// bubble, block-type dropdown, and link editor are presentation only: they read a
// MenuSnapshot and call command methods, never touching the block surface
// directly. The surface provides an adapter implementing MenuController
// (BlockMenuController). The interface was the parity lift the cutover (SKR-111)
// relied on: because the menus lived outside the engines, deleting ProseMirror
// removed only its adapter, not the affordances. The PM adapter is now gone; the
// abstraction remains so a second surface (or host) can reuse the menus.
//
// The generalization into an open, third-party affordance registry (SKR-110) is
// deliberately NOT here; this is a closed interface.

/** The focused block's type, for the "Turn into" control's label and active
 *  state. `other` covers container/table contexts the dropdown leaves alone. */
export type MenuBlockType = 'paragraph' | 'heading' | 'code_block' | 'table' | 'other';

/** The selection's formatting context the menus render from. Mirrors the Rich
 *  surface's RichSelectionSummary and the bespoke surface's SelectionInfo, the
 *  superset both can satisfy. */
export type MenuSelection = {
  /** True when there is no range to format (collapsed caret / cross-block). The
   *  fixed toolbar still renders; the bubble hides. */
  empty: boolean;
  strong: boolean;
  em: boolean;
  code: boolean;
  strikethrough: boolean;
  underline: boolean;
  link: boolean;
  linkHref: string | null;
  blockType: MenuBlockType;
  headingLevel: number | null;
  inBulletList: boolean;
  inOrderedList: boolean;
  inBlockquote: boolean;
  inTable: boolean;
};

/** The transient link-editor state (open + prefill + whether a link already
 *  covers the target, so the editor offers Remove). */
export type MenuLinkState = { open: boolean; href: string; editing: boolean };

/** A viewport-space rectangle for anchoring a floating box. A DOMRect satisfies
 *  this structurally, as does a rect built from PM's coordsAtPos. */
export type AnchorRect = { top: number; bottom: number; left: number; right: number };

export type MenuSnapshot = {
  selection: MenuSelection;
  link: MenuLinkState;
  /** True while a pointer drag-select is in progress, so the bubble stays hidden
   *  until release instead of chasing the growing selection (SKR-184). */
  dragging: boolean;
  /** Bumped whenever the anchor geometry may have shifted, to force the floating
   *  boxes to re-measure (selection move, doc edit). */
  rev: number;
};

export const EMPTY_MENU_SELECTION: MenuSelection = {
  empty: true,
  strong: false,
  em: false,
  code: false,
  strikethrough: false,
  underline: false,
  link: false,
  linkHref: null,
  blockType: 'paragraph',
  headingLevel: null,
  inBulletList: false,
  inOrderedList: false,
  inBlockquote: false,
  inTable: false
};

export const CLOSED_MENU_LINK: MenuLinkState = { open: false, href: '', editing: false };

/** The contract the shared menus consume. Both adapters keep a cached snapshot so
 *  getSnapshot() is referentially stable between changes (useSyncExternalStore). */
export interface MenuController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MenuSnapshot;
  /** The selection's bounding rect (viewport coords) for the bubble / link editor,
   *  or null when there is nothing to anchor to. Cached at the last selection change. */
  anchorRect(): AnchorRect | null;
  /** The CURRENT selection's rect, re-measured live — for re-anchoring on scroll,
   *  where no selectionchange fires and `anchorRect()` would be stale (SKR-184). */
  liveAnchorRect(): AnchorRect | null;

  // Inline marks.
  toggleMark(mark: 'strong' | 'em' | 'code' | 'strikethrough' | 'underline'): void;

  // Block type ("Turn into") and wrap toggles.
  setParagraph(): void;
  setHeading(level: number): void;
  setCodeBlock(): void;
  toggleBulletList(): void;
  toggleOrderedList(): void;
  toggleBlockquote(): void;
  insertDivider(): void;
  insertTable(): void;

  // Link affordance: open the floating editor against the current selection, then
  // commit / remove / cancel. The adapter preserves the target across the input
  // taking focus (PM keeps it in state; the bespoke surface saves it explicitly).
  openLinkEditor(): void;
  commitLink(href: string): void;
  removeLink(): void;
  closeLinkEditor(): void;

  focusEditor(): void;
}
