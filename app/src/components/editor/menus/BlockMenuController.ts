// MenuController adapter over the bespoke block surface. Subscribes to the
// surface's rAF-coalesced selection observer and maps its SelectionInfo to the
// editor-agnostic MenuSelection; routes the shared menus' commands to the
// surface's command API. The link editor's target is preserved across the input
// taking focus via the surface's saved-selection (beginLink/commitLink), since a
// contenteditable selection collapses when focus leaves it.

import type { BlockSurface, SelectionInfo } from '../../../lib/blocksurface';
import {
  type AnchorRect,
  type MenuController,
  type MenuLinkState,
  type MenuSelection,
  type MenuSnapshot,
  CLOSED_MENU_LINK,
  EMPTY_MENU_SELECTION
} from './controller';

function selectionsEqual(a: MenuSelection, b: MenuSelection): boolean {
  return (
    a.empty === b.empty &&
    a.strong === b.strong &&
    a.em === b.em &&
    a.code === b.code &&
    a.link === b.link &&
    a.linkHref === b.linkHref &&
    a.blockType === b.blockType &&
    a.headingLevel === b.headingLevel &&
    a.inBulletList === b.inBulletList &&
    a.inOrderedList === b.inOrderedList &&
    a.inBlockquote === b.inBlockquote &&
    a.inTable === b.inTable
  );
}

function toSelection(info: SelectionInfo | null): MenuSelection {
  if (!info) return EMPTY_MENU_SELECTION;
  return {
    empty: info.empty,
    strong: info.marks.strong,
    em: info.marks.em,
    code: info.marks.code,
    link: info.marks.link,
    linkHref: info.linkHref,
    blockType: info.blockType,
    headingLevel: info.headingLevel,
    inBulletList: info.inBulletList,
    inOrderedList: info.inOrderedList,
    inBlockquote: info.inBlockquote,
    inTable: info.inTable
  };
}

export class BlockMenuController implements MenuController {
  private readonly listeners = new Set<() => void>();
  private snapshot: MenuSnapshot = { selection: EMPTY_MENU_SELECTION, link: CLOSED_MENU_LINK, dragging: false, rev: 0 };
  private selection: MenuSelection = EMPTY_MENU_SELECTION;
  private link: MenuLinkState = CLOSED_MENU_LINK;
  private rect: AnchorRect | null = null;
  private dragging = false;
  private rev = 0;

  constructor(private readonly surface: BlockSurface) {
    this.ingest(surface.getSelectionInfo());
    surface.onSelectionChange((info) => this.ingest(info));
    // ⌘K in the surface opens the link editor through the same path as the toolbar
    // / bubble Link button (SKR-177).
    surface.onRequestLinkEditor(() => this.openLinkEditor());
  }

  destroy(): void {
    this.surface.onSelectionChange(null);
    this.surface.onRequestLinkEditor(null);
    this.listeners.clear();
  }

  private ingest(info: SelectionInfo | null): void {
    this.rect = info?.rect ?? null; // always fresh: anchorRect() reads it on demand
    const dragging = info?.dragging ?? false;
    const next = toSelection(info);
    // A collapsed caret moving (every keystroke) changes only the rect. With the
    // bubble hidden (empty) and no link editor anchored, nothing React-visible
    // changed — skip the rev bump so typing doesn't re-render the chrome per
    // keystroke (SKR-190). A visible bubble or an open link editor still
    // re-anchors on every frame via the commit below.
    if (next.empty && !this.link.open && this.dragging === dragging && selectionsEqual(next, this.selection)) {
      return;
    }
    this.dragging = dragging;
    this.selection = next;
    this.commit();
  }

  private commit(): void {
    this.snapshot = { selection: this.selection, link: this.link, dragging: this.dragging, rev: ++this.rev };
    for (const l of this.listeners) l();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): MenuSnapshot => this.snapshot;
  anchorRect = (): AnchorRect | null => this.rect;
  liveAnchorRect = (): AnchorRect | null => this.surface.currentSelectionRect();

  toggleMark(mark: 'strong' | 'em' | 'code'): void {
    this.surface.toggleMark(mark);
  }
  setParagraph(): void {
    this.surface.setBlockType({ kind: 'paragraph' });
  }
  setHeading(level: number): void {
    this.surface.setBlockType({ kind: 'heading', level });
  }
  setCodeBlock(): void {
    this.surface.setBlockType({ kind: 'code' });
  }
  toggleBulletList(): void {
    this.surface.toggleList('bullet_list');
  }
  toggleOrderedList(): void {
    this.surface.toggleList('ordered_list');
  }
  toggleBlockquote(): void {
    this.surface.toggleQuote();
  }
  insertDivider(): void {
    this.surface.setBlockType({ kind: 'divider' });
  }
  insertTable(): void {
    this.surface.setBlockType({ kind: 'table' });
  }

  openLinkEditor(): void {
    if (!this.surface.beginLink()) return;
    this.link = { open: true, href: this.selection.linkHref ?? '', editing: this.selection.link };
    this.commit();
  }
  commitLink(href: string): void {
    this.surface.commitLink(href);
    this.closeLink();
  }
  removeLink(): void {
    this.surface.removeLink();
    this.closeLink();
  }
  closeLinkEditor(): void {
    this.surface.cancelLink();
    this.closeLink();
  }
  private closeLink(): void {
    this.link = CLOSED_MENU_LINK;
    this.commit();
  }

  focusEditor(): void {
    this.surface.focus();
  }
}
