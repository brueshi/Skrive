// The slim, fixed block-action bar pinned to the top of the writing column. Stable
// position, never pointer-following — the home for custom Skrive iconography. It
// reads live selection state from the MenuController (so the active block type and
// mark buttons light up as the cursor moves) and dispatches the controller's
// commands. Shared by both editors; the controller adapts it to PM or the bespoke
// surface. Buttons preventDefault on mousedown so a click never blurs the editor
// and collapses the selection before the command runs.

import { useSyncExternalStore } from 'react';
import type { MenuController } from './controller';
import { BlockTypeDropdown } from './BlockTypeDropdown';
import { InsertMenu } from './InsertMenu';
import { Tooltip } from '../../ui/Tooltip';
import { IconBold, IconItalic, IconInlineCode } from './toolbar-icons';
import './menus.css';

function ToolbarButton({
  label,
  shortcut,
  active = false,
  disabled = false,
  onRun,
  children
}: {
  label: string;
  /** macOS-symbol shortcut hint for the tooltip. Omitted where none is bound. */
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onRun: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        className={`rich-toolbar-button${active ? ' active' : ''}`}
        aria-pressed={active}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRun}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function Toolbar({ controller }: { controller: MenuController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const s = snap.selection;

  // The permanent set, fixed forever by the affordance grammar (SKR-243):
  //   [ Turn into ▾ ] | B  I  ⌍code⌎ | [ Insert ▾ ]
  // Turn into absorbs every block transformation; the marks are B / I / inline
  // code (Link is bubble-only, resolved call 1); Insert is the discoverable
  // catalog. Adding a button here is forbidden — see chrome-affordance-grammar.md
  // rule 7. Divider / Table and the list/quote/code conversions that used to have
  // standalone buttons now live in Turn into and Insert.
  return (
    <div className="rich-toolbar">
      <div className="rich-toolbar-inner" role="toolbar" aria-label="Formatting">
        <BlockTypeDropdown controller={controller} selection={s} disabled={s.inTable} />

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Bold" shortcut="⌘B" active={s.strong} onRun={() => controller.toggleMark('strong')}>
          <IconBold />
        </ToolbarButton>
        <ToolbarButton label="Italic" shortcut="⌘I" active={s.em} onRun={() => controller.toggleMark('em')}>
          <IconItalic />
        </ToolbarButton>
        <ToolbarButton label="Inline code" shortcut="⌘E" active={s.code} onRun={() => controller.toggleMark('code')}>
          <IconInlineCode />
        </ToolbarButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <InsertMenu controller={controller} disabled={s.inTable} />
      </div>
    </div>
  );
}
