// The slim, fixed block-action bar pinned to the top of the Rich writing column.
// Stable position, never pointer-following (master plan, Stage 3) — the agreed
// home for custom Skrive iconography. It reads live state from the
// selection-state store (so the active block type and mark buttons light up as
// the cursor moves) and dispatches the projection command layer against the
// surface's EditorView. Buttons preventDefault on mousedown so a click never
// blurs the editor and collapses the selection before the command runs.

import { useCallback } from 'react';
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
  insertTable
} from '../../../lib/projection/commands';
import { useRichUiStore } from './selection-state';
import { BlockTypeDropdown } from './BlockTypeDropdown';
import {
  IconBold,
  IconItalic,
  IconCode,
  IconLink,
  IconQuote,
  IconBulletList,
  IconOrderedList,
  IconDivider,
  IconTable
} from './toolbar-icons';

type Props = { view: EditorView };

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onRun,
  children
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
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
      disabled={disabled}
      // Keep focus (and thus the selection) in the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function RichToolbar({ view }: Props) {
  const s = useRichUiStore((st) => st.selection);
  const openLinkEditor = useRichUiStore((st) => st.openLinkEditor);

  const run = useCallback(
    (cmd: Command) => {
      cmd(view.state, view.dispatch, view);
      view.focus();
    },
    [view]
  );

  const onLink = useCallback(() => {
    // Need either a range to wrap or an existing link under the cursor.
    if (s.empty && !s.link) return;
    openLinkEditor(s.linkHref ?? '', s.link);
  }, [s.empty, s.link, s.linkHref, openLinkEditor]);

  return (
    <div className="rich-toolbar">
      <div className="rich-toolbar-inner" role="toolbar" aria-label="Formatting">
      <BlockTypeDropdown
        view={view}
        blockType={s.blockType}
        headingLevel={s.headingLevel}
      />

      <span className="rich-toolbar-sep" aria-hidden="true" />

      <ToolbarButton label="Bold" active={s.strong} onRun={() => run(toggleStrong)}>
        <IconBold />
      </ToolbarButton>
      <ToolbarButton label="Italic" active={s.em} onRun={() => run(toggleEm)}>
        <IconItalic />
      </ToolbarButton>
      <ToolbarButton label="Inline code" active={s.code} onRun={() => run(toggleCode)}>
        <IconCode />
      </ToolbarButton>
      <ToolbarButton
        label="Link"
        active={s.link}
        disabled={s.empty && !s.link}
        onRun={onLink}
      >
        <IconLink />
      </ToolbarButton>

      <span className="rich-toolbar-sep" aria-hidden="true" />

      <ToolbarButton
        label="Bulleted list"
        active={s.inBulletList}
        onRun={() => run(toggleBulletList)}
      >
        <IconBulletList />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={s.inOrderedList}
        onRun={() => run(toggleOrderedList)}
      >
        <IconOrderedList />
      </ToolbarButton>
      <ToolbarButton
        label="Quote"
        active={s.inBlockquote}
        onRun={() => run(toggleBlockquote)}
      >
        <IconQuote />
      </ToolbarButton>

      <span className="rich-toolbar-sep" aria-hidden="true" />

      <ToolbarButton label="Divider" onRun={() => run(insertDivider)}>
        <IconDivider />
      </ToolbarButton>
      <ToolbarButton label="Table" onRun={() => run(insertTable)}>
        <IconTable />
      </ToolbarButton>
      </div>
    </div>
  );
}
