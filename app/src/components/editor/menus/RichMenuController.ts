// MenuController adapter over the ProseMirror Rich surface. A thin read-through:
// the selection summary + link-editor state come straight from the existing
// rAF-coalesced useRichUiStore (untouched, so the primary editor's "no
// per-keystroke React" plumbing is preserved), and commands dispatch the
// projection command layer against the EditorView. Geometry is the selection's
// coordsAtPos, packed into an AnchorRect for the shared floating boxes.

import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  toggleStrong,
  toggleEm,
  toggleCode,
  toggleBulletList,
  toggleOrderedList,
  toggleBlockquote,
  insertDivider,
  insertTable,
  setParagraph,
  setHeading,
  setCodeBlock,
  setLink,
  removeLink
} from '../../../lib/projection/commands';
import { useRichUiStore } from '../rich/selection-state';
import {
  type AnchorRect,
  type MenuBlockType,
  type MenuController,
  type MenuSnapshot,
  CLOSED_MENU_LINK,
  EMPTY_MENU_SELECTION
} from './controller';

function mapBlockType(blockType: string, inTable: boolean): MenuBlockType {
  if (blockType === 'heading' || blockType === 'code_block' || blockType === 'paragraph') return blockType;
  return inTable ? 'table' : 'other';
}

export class RichMenuController implements MenuController {
  private readonly listeners = new Set<() => void>();
  private snapshot: MenuSnapshot = { selection: EMPTY_MENU_SELECTION, link: CLOSED_MENU_LINK, rev: 0 };
  private readonly unsubStore: () => void;

  constructor(private readonly view: EditorView) {
    this.rebuild();
    this.unsubStore = useRichUiStore.subscribe(() => {
      this.rebuild();
      for (const l of this.listeners) l();
    });
  }

  destroy(): void {
    this.unsubStore();
    this.listeners.clear();
  }

  private rebuild(): void {
    const st = useRichUiStore.getState();
    const sel = st.selection;
    this.snapshot = {
      selection: {
        empty: sel.empty,
        strong: sel.strong,
        em: sel.em,
        code: sel.code,
        link: sel.link,
        linkHref: sel.linkHref,
        blockType: mapBlockType(sel.blockType, sel.inTable),
        headingLevel: sel.headingLevel,
        inBulletList: sel.inBulletList,
        inOrderedList: sel.inOrderedList,
        inBlockquote: sel.inBlockquote,
        inTable: sel.inTable
      },
      link: { open: st.linkEditor.open, href: st.linkEditor.href, editing: st.linkEditor.editing },
      // geometry doubles as the re-measure revision for the floating boxes.
      rev: st.geometry
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): MenuSnapshot => this.snapshot;
  anchorRect = (): AnchorRect | null => {
    const st = useRichUiStore.getState();
    try {
      const a = this.view.coordsAtPos(st.selFrom);
      const b = this.view.coordsAtPos(st.selTo);
      return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), left: a.left, right: b.right };
    } catch {
      return null;
    }
  };

  private run(cmd: Command): void {
    cmd(this.view.state, this.view.dispatch, this.view);
    this.view.focus();
  }

  toggleMark(mark: 'strong' | 'em' | 'code'): void {
    this.run(mark === 'strong' ? toggleStrong : mark === 'em' ? toggleEm : toggleCode);
  }
  setParagraph(): void {
    this.run(setParagraph);
  }
  setHeading(level: number): void {
    this.run(setHeading(level));
  }
  setCodeBlock(): void {
    this.run(setCodeBlock);
  }
  toggleBulletList(): void {
    this.run(toggleBulletList);
  }
  toggleOrderedList(): void {
    this.run(toggleOrderedList);
  }
  toggleBlockquote(): void {
    this.run(toggleBlockquote);
  }
  insertDivider(): void {
    this.run(insertDivider);
  }
  insertTable(): void {
    this.run(insertTable);
  }

  openLinkEditor(): void {
    const sel = useRichUiStore.getState().selection;
    if (sel.empty && !sel.link) return; // need a range to wrap or a link to edit
    useRichUiStore.getState().openLinkEditor(sel.linkHref ?? '', sel.link);
  }
  commitLink(href: string): void {
    this.run(setLink(href));
    useRichUiStore.getState().closeLinkEditor();
  }
  removeLink(): void {
    this.run(removeLink);
    useRichUiStore.getState().closeLinkEditor();
  }
  closeLinkEditor(): void {
    useRichUiStore.getState().closeLinkEditor();
  }

  focusEditor(): void {
    this.view.focus();
  }
}
