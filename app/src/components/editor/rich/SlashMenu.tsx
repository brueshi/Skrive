// The slash insert menu: a filtered list of block types that appears below the
// `/` trigger. Selection is driven from the keyboard by slash-plugin (focus
// stays in the editor while the menu shows), so this component only renders the
// list and handles clicks. It portals to <body> and anchors with the shared
// positioning hook, like the bubble and link editor.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { EditorView } from 'prosemirror-view';
import { useRichUiStore } from './selection-state';
import { useAnchoredBox } from './use-anchored-box';
import { filterSlashItems, commitSlash } from './slash-items';

type Props = { view: EditorView };

export function SlashMenu({ view }: Props) {
  const open = useRichUiStore((s) => s.slash.open);
  const query = useRichUiStore((s) => s.slash.query);
  const from = useRichUiStore((s) => s.slash.from);
  const index = useRichUiStore((s) => s.slash.index);
  const geometry = useRichUiStore((s) => s.geometry);
  const reduced = useReducedMotion();

  const items = filterSlashItems(query);
  const visible = open && items.length > 0;
  const anchor = from >= 0 ? from : 0;
  // Re-measure as the query (and thus the list height) changes.
  const { ref, pos } = useAnchoredBox(view, anchor, anchor, visible, geometry + query.length, 'below');

  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index, visible]);

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={ref}
          className="rich-slash-menu"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="listbox"
          aria-label="Insert block"
          initial={reduced ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => {
            const active = i === index;
            return (
              <button
                key={item.id}
                ref={active ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={active}
                className={`rich-slash-item${active ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitSlash(view, item)}
              >
                <span className="rich-slash-icon">
                  <item.Icon size={16} />
                </span>
                <span className="rich-slash-title">{item.title}</span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
