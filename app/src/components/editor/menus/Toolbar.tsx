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
  IconInlineCode,
  IconLink,
  IconQuote,
  IconBulletList,
  IconOrderedList,
  IconCodeBlock,
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
        <BlockTypeDropdown
          controller={controller}
          blockType={s.blockType}
          headingLevel={s.headingLevel}
          disabled={s.inTable}
        />

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Bold" active={s.strong} onRun={() => controller.toggleMark('strong')}>
          <IconBold />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={s.em} onRun={() => controller.toggleMark('em')}>
          <IconItalic />
        </ToolbarButton>
        <ToolbarButton label="Inline code" active={s.code} onRun={() => controller.toggleMark('code')}>
          <IconInlineCode />
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

        {/* Bulleted/Numbered/Quote/Code/Divider/Table are all block-type
            conversions, same as "Turn into" above: a table cell is
            coordinate-addressed, not a leaf block, so none of them have anything
            to act on there (SKR-219). Disabled together for the same reason. */}
        <ToolbarButton
          label="Bulleted list"
          active={s.inBulletList}
          disabled={s.inTable}
          onRun={() => controller.toggleBulletList()}
        >
          <IconBulletList />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          active={s.inOrderedList}
          disabled={s.inTable}
          onRun={() => controller.toggleOrderedList()}
        >
          <IconOrderedList />
        </ToolbarButton>
        <ToolbarButton label="Quote" active={s.inBlockquote} disabled={s.inTable} onRun={() => controller.toggleBlockquote()}>
          <IconQuote />
        </ToolbarButton>
        <ToolbarButton
          label="Code block"
          active={s.blockType === 'code_block'}
          disabled={s.inTable}
          onRun={() =>
            s.blockType === 'code_block'
              ? controller.setParagraph()
              : controller.setCodeBlock()
          }
        >
          <IconCodeBlock />
        </ToolbarButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolbarButton label="Divider" disabled={s.inTable} onRun={() => controller.insertDivider()}>
          <IconDivider />
        </ToolbarButton>
        <ToolbarButton label="Table" disabled={s.inTable} onRun={() => controller.insertTable()}>
          <IconTable />
        </ToolbarButton>
      </div>
    </div>
  );
}
