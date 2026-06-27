// The slash menu's catalogue and commit path, shared by the plugin (which owns
// keyboard navigation, since focus stays in the editor) and the menu component
// (which renders). Keeping the list and the filter in one place means the two
// can never disagree about which item Enter selects vs. which the menu shows.

import type { ComponentType } from 'react';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  setParagraph,
  setHeading,
  setCodeBlock,
  toggleBulletList,
  toggleOrderedList,
  toggleBlockquote,
  insertDivider,
  insertTable
} from '../../../lib/projection/commands';
import { useRichUiStore } from './selection-state';
import {
  IconParagraph,
  IconHeading,
  IconQuote,
  IconBulletList,
  IconOrderedList,
  IconDivider,
  IconTable,
  IconCodeBlock
} from '../menus/toolbar-icons';

export type SlashItem = {
  id: string;
  title: string;
  keywords: string[];
  Icon: ComponentType<{ size?: number; className?: string }>;
  run: (view: EditorView) => void;
};

function asRun(cmd: Command): (view: EditorView) => void {
  return (view) => {
    cmd(view.state, view.dispatch, view);
  };
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', title: 'Text', keywords: ['paragraph', 'plain', 'body'], Icon: IconParagraph, run: asRun(setParagraph) },
  { id: 'h1', title: 'Heading 1', keywords: ['title', 'h1', 'heading'], Icon: IconHeading, run: asRun(setHeading(1)) },
  { id: 'h2', title: 'Heading 2', keywords: ['h2', 'heading', 'subtitle'], Icon: IconHeading, run: asRun(setHeading(2)) },
  { id: 'h3', title: 'Heading 3', keywords: ['h3', 'heading'], Icon: IconHeading, run: asRun(setHeading(3)) },
  { id: 'bullet', title: 'Bulleted list', keywords: ['ul', 'unordered', 'list', 'bullet'], Icon: IconBulletList, run: asRun(toggleBulletList) },
  { id: 'ordered', title: 'Numbered list', keywords: ['ol', 'ordered', 'list', 'number'], Icon: IconOrderedList, run: asRun(toggleOrderedList) },
  { id: 'quote', title: 'Quote', keywords: ['blockquote', 'cite'], Icon: IconQuote, run: asRun(toggleBlockquote) },
  { id: 'code', title: 'Code block', keywords: ['fence', 'pre', 'snippet'], Icon: IconCodeBlock, run: asRun(setCodeBlock) },
  { id: 'divider', title: 'Divider', keywords: ['hr', 'rule', 'separator', 'break'], Icon: IconDivider, run: asRun(insertDivider) },
  { id: 'table', title: 'Table', keywords: ['grid', 'rows', 'columns'], Icon: IconTable, run: asRun(insertTable) }
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.keywords.some((k) => k.includes(q))
  );
}

// Commit a chosen item: remove the `/query` text the writer typed, then run the
// item's command at the now-cleared line. Two transactions (delete, then the
// command) so each affordance command sees a clean, query-free document.
export function commitSlash(view: EditorView, item: SlashItem): void {
  const store = useRichUiStore.getState();
  const from = store.slash.from;
  const to = view.state.selection.from;
  if (from >= 0 && to >= from) {
    view.dispatch(view.state.tr.delete(from, to));
  }
  item.run(view);
  store.closeSlash();
  view.focus();
}
