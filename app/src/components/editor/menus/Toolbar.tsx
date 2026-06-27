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
import './menus.css';

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
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function Toolbar({ controller }: { controller: MenuController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const s = snap.selection;

  return (
    <div className="rich-toolbar">
      <div className="rich-toolbar-inner" role="toolbar" aria-label="Formatting">
        <BlockTypeDropdown controller={controller} blockType={s.blockType} headingLevel={s.headingLevel} />

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Bold" active={s.strong} onRun={() => controller.toggleMark('strong')}>
          <IconBold />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={s.em} onRun={() => controller.toggleMark('em')}>
          <IconItalic />
        </ToolbarButton>
        <ToolbarButton label="Inline code" active={s.code} onRun={() => controller.toggleMark('code')}>
          <IconCode />
        </ToolbarButton>
        <ToolbarButton
          label="Link"
          active={s.link}
          disabled={s.empty && !s.link}
          onRun={() => controller.openLinkEditor()}
        >
          <IconLink />
        </ToolbarButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Bulleted list" active={s.inBulletList} onRun={() => controller.toggleBulletList()}>
          <IconBulletList />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" active={s.inOrderedList} onRun={() => controller.toggleOrderedList()}>
          <IconOrderedList />
        </ToolbarButton>
        <ToolbarButton label="Quote" active={s.inBlockquote} onRun={() => controller.toggleBlockquote()}>
          <IconQuote />
        </ToolbarButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Divider" onRun={() => controller.insertDivider()}>
          <IconDivider />
        </ToolbarButton>
        <ToolbarButton label="Table" onRun={() => controller.insertTable()}>
          <IconTable />
        </ToolbarButton>
      </div>
    </div>
  );
}
