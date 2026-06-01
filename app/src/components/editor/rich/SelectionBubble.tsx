// The floating selection bubble: appears above a non-empty text selection with
// the inline-formatting affordances (block-type switch + bold / italic / code /
// link), in the spirit of Notion's selection toolbar — but with no AI surface
// (off-brand). It reads live state from the selection store and dispatches the
// projection command layer.
//
// It renders into document.body via a portal and positions itself with
// `position: fixed` from `view.coordsAtPos` (which returns viewport coordinates),
// so it can't be clipped by the editor's scroll container or by an animated
// ancestor's transform. It stays anchored across editor scrolls and window
// resizes, and never steals focus (mousedown is prevented) so the selection it
// acts on survives the click.

import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { toggleStrong, toggleEm, toggleCode } from '../../../lib/projection/commands';
import { useRichUiStore } from './selection-state';
import { useAnchoredBox } from './use-anchored-box';
import { BlockTypeDropdown } from './BlockTypeDropdown';
import { IconBold, IconItalic, IconCode, IconLink } from './toolbar-icons';

type Props = { view: EditorView };

function BubbleButton({
  label,
  active = false,
  onRun,
  children
}: {
  label: string;
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
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function SelectionBubble({ view }: Props) {
  const selection = useRichUiStore((s) => s.selection);
  const selFrom = useRichUiStore((s) => s.selFrom);
  const selTo = useRichUiStore((s) => s.selTo);
  const geometry = useRichUiStore((s) => s.geometry);
  const linkOpen = useRichUiStore((s) => s.linkEditor.open);
  const slashOpen = useRichUiStore((s) => s.slash.open);
  const openLinkEditor = useRichUiStore((s) => s.openLinkEditor);

  const reduced = useReducedMotion();

  const visible =
    !selection.empty &&
    !linkOpen &&
    !slashOpen &&
    selection.blockType !== 'code_block' &&
    selection.blockType !== 'doc';

  const { ref, pos } = useAnchoredBox(view, selFrom, selTo, visible, geometry, 'above');

  const run = useCallback(
    (cmd: Command) => {
      cmd(view.state, view.dispatch, view);
      view.focus();
    },
    [view]
  );

  const onLink = useCallback(() => {
    openLinkEditor(selection.linkHref ?? '', selection.link);
  }, [openLinkEditor, selection.linkHref, selection.link]);

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
          <BlockTypeDropdown
            view={view}
            blockType={selection.blockType}
            headingLevel={selection.headingLevel}
          />
          <span className="rich-toolbar-sep" aria-hidden="true" />
          <BubbleButton label="Bold" active={selection.strong} onRun={() => run(toggleStrong)}>
            <IconBold />
          </BubbleButton>
          <BubbleButton label="Italic" active={selection.em} onRun={() => run(toggleEm)}>
            <IconItalic />
          </BubbleButton>
          <BubbleButton label="Inline code" active={selection.code} onRun={() => run(toggleCode)}>
            <IconCode />
          </BubbleButton>
          <BubbleButton label="Link" active={selection.link} onRun={onLink}>
            <IconLink />
          </BubbleButton>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
