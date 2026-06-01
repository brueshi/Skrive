// The slash trigger. A `/` at the start of an empty-ish paragraph (or after
// whitespace) opens an insert menu; what follows filters it. The plugin owns two
// things: detecting/updating the trigger on each view update, and — because the
// editor keeps focus while the menu shows — intercepting Arrow/Enter/Tab/Escape
// to drive the menu's selection. The menu UI (SlashMenu) only renders.
//
// The document is never mutated by the trigger itself: the `/query` is ordinary
// typed text. Dismissing the menu (Escape) leaves exactly what was typed —
// byte-honest — and committing an item removes the `/query` before inserting.
//
// Must sit BEFORE the editing keymaps in the plugin list so its handleKeyDown
// claims Enter/Arrow first while the menu is open.

import { Plugin } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { useRichUiStore } from './selection-state';
import { filterSlashItems, commitSlash } from './slash-items';

function detectSlash(state: EditorState): { query: string; from: number } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  // Only plain paragraphs trigger — not headings, code blocks, or table cells.
  if ($pos.parent.type.name !== 'paragraph') return null;

  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼');
  // A `/` at line start or after whitespace, then the (space-free) query. This
  // leaves real path-like text ("a/b") alone — the `/` there isn't a trigger.
  const m = /(?:^|\s)\/(\S*)$/.exec(textBefore);
  if (!m) return null;

  const query = m[1] ?? '';
  const slashOffset = m.index + (m[0].startsWith('/') ? 0 : 1);
  return { query, from: $pos.start() + slashOffset };
}

export function slashPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const store = useRichUiStore.getState();
        if (!store.slash.open) return false;

        if (event.key === 'Escape') {
          store.closeSlash();
          return true;
        }

        const items = filterSlashItems(store.slash.query);
        if (!items.length) return false; // nothing to navigate; type/Enter as usual

        if (event.key === 'ArrowDown') {
          store.setSlashIndex(Math.min(store.slash.index + 1, items.length - 1));
          return true;
        }
        if (event.key === 'ArrowUp') {
          store.setSlashIndex(Math.max(store.slash.index - 1, 0));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[Math.min(store.slash.index, items.length - 1)];
          if (item) commitSlash(view, item);
          return true;
        }
        return false;
      }
    },
    view() {
      return {
        update(view) {
          const hit = detectSlash(view.state);
          const store = useRichUiStore.getState();
          if (hit) store.setSlash(hit.query, hit.from);
          else store.closeSlash();
        }
      };
    }
  });
}
