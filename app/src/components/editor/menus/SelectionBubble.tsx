// The floating selection bubble: appears above a non-empty text selection with the
// inline-formatting affordances (block-type switch + bold / italic / code / link),
// in the spirit of Notion's selection toolbar — no AI surface (off-brand). Reads
// live state from the MenuController and dispatches its commands. Renders into a
// body portal, positioned `fixed` from the controller's anchor rect so it can't be
// clipped by the editor's scroll container, and never steals focus (mousedown
// prevented) so the selection it acts on survives the click. Shared by both editors.

import { createPortal } from 'react-dom';
import { useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { MenuController } from './controller';
import { platformShortcut } from '../../../lib/commands/shortcut-display';
import { useAnchoredRect } from './useAnchoredRect';
import { BlockTypeDropdown } from './BlockTypeDropdown';
import { IconBold, IconItalic, IconCodeBlock, IconLink } from './toolbar-icons';
import './menus.css';

function BubbleButton({
  label,
  shortcut,
  active = false,
  onRun,
  children
}: {
  label: string;
  /** macOS-symbol shortcut hint, shown in the tooltip so the bubble teaches
   *  the keyboard path at the moment of use. Omitted where none is bound. */
  shortcut?: string;
  active?: boolean;
  onRun: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rich-toolbar-button${active ? ' active' : ''}`}
      aria-pressed={active}
      aria-label={label}
      title={shortcut ? `${label} (${platformShortcut(shortcut)})` : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function SelectionBubble({ controller }: { controller: MenuController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const s = snap.selection;
  const reduced = useReducedMotion();

  const visible = !s.empty && !snap.link.open && s.blockType !== 'code_block';
  const { ref, pos } = useAnchoredRect(controller.anchorRect(), visible, snap.rev, 'above');

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={ref}
          className="rich-bubble"
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          role="toolbar"
          aria-label="Selection formatting"
          initial={reduced ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <BlockTypeDropdown controller={controller} blockType={s.blockType} headingLevel={s.headingLevel} />
          <span className="rich-toolbar-sep" aria-hidden="true" />
          <BubbleButton label="Bold" shortcut="⌘B" active={s.strong} onRun={() => controller.toggleMark('strong')}>
            <IconBold />
          </BubbleButton>
          <BubbleButton label="Italic" shortcut="⌘I" active={s.em} onRun={() => controller.toggleMark('em')}>
            <IconItalic />
          </BubbleButton>
          <BubbleButton label="Inline code" shortcut="⌘E" active={s.code} onRun={() => controller.toggleMark('code')}>
            <IconCodeBlock />
          </BubbleButton>
          <BubbleButton label="Link" active={s.link} onRun={() => controller.openLinkEditor()}>
            <IconLink />
          </BubbleButton>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
