// The "Turn into" control, shared by the fixed toolbar and the selection bubble
// so the two never drift. Under the affordance grammar (SKR-243) it absorbs every
// block transformation: the mutually-exclusive textblocks (Text / Heading 1-3),
// the wrap toggles (Bullet / Numbered list, Quote), and Code block — the six
// standalone toolbar buttons that used to carry these are retired. Divider and
// Table are NOT here: they insert new blocks rather than transform the current
// one, so they live only in the Insert catalog. Every item dispatches through the
// same dispatchInsert the Insert dropdown and palette use. Driven by the
// editor-agnostic MenuController.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Fragment, type ComponentType } from 'react';
import type { BlockTypeSpec } from '../../../lib/blocksurface';
import type { MenuController, MenuSelection } from './controller';
import { dispatchInsert } from './insert-catalog';
import {
  IconChevronDown,
  IconParagraph,
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconBulletList,
  IconOrderedList,
  IconQuote,
  IconCodeBlock
} from './toolbar-icons';

type IconC = ComponentType<{ size?: number; className?: string }>;

/** A "Turn into" row. `active` reports whether the current selection is already
 *  this type, so the menu can check it — and `group` drives the hairlines. */
type TurnItem = {
  id: string;
  label: string;
  Icon: IconC;
  spec: BlockTypeSpec;
  group: 'text' | 'list' | 'wrap';
  active: (s: MenuSelection) => boolean;
};

// A paragraph inside a list/quote still reports blockType 'paragraph', so plain
// Text is "active" only when it is a bare top-level paragraph — otherwise the
// wrapping row owns the checkmark.
const isBareParagraph = (s: MenuSelection) =>
  s.blockType === 'paragraph' && !s.inBulletList && !s.inOrderedList && !s.inBlockquote;

const TURN_ITEMS: TurnItem[] = [
  { id: 'text', label: 'Text', Icon: IconParagraph, spec: { kind: 'paragraph' }, group: 'text', active: isBareParagraph },
  { id: 'heading-1', label: 'Heading 1', Icon: IconHeading1, spec: { kind: 'heading', level: 1 }, group: 'text', active: (s) => s.blockType === 'heading' && s.headingLevel === 1 },
  { id: 'heading-2', label: 'Heading 2', Icon: IconHeading2, spec: { kind: 'heading', level: 2 }, group: 'text', active: (s) => s.blockType === 'heading' && s.headingLevel === 2 },
  { id: 'heading-3', label: 'Heading 3', Icon: IconHeading3, spec: { kind: 'heading', level: 3 }, group: 'text', active: (s) => s.blockType === 'heading' && s.headingLevel === 3 },
  { id: 'bullet-list', label: 'Bullet list', Icon: IconBulletList, spec: { kind: 'bullet_list' }, group: 'list', active: (s) => s.inBulletList },
  { id: 'numbered-list', label: 'Numbered list', Icon: IconOrderedList, spec: { kind: 'ordered_list' }, group: 'list', active: (s) => s.inOrderedList },
  { id: 'quote', label: 'Quote', Icon: IconQuote, spec: { kind: 'blockquote' }, group: 'wrap', active: (s) => s.inBlockquote },
  { id: 'code', label: 'Code block', Icon: IconCodeBlock, spec: { kind: 'code' }, group: 'wrap', active: (s) => s.blockType === 'code_block' }
];

/** The trigger's current-type label. Wrap types (list/quote) win over the leaf's
 *  paragraph blockType so the pill reflects what the caret is actually in. */
export function blockTypeLabel(s: MenuSelection): string {
  if (s.inBulletList) return 'Bullet list';
  if (s.inOrderedList) return 'Numbered list';
  if (s.inBlockquote) return 'Quote';
  if (s.blockType === 'heading') return `Heading ${s.headingLevel ?? 1}`;
  if (s.blockType === 'code_block') return 'Code block';
  return 'Text';
}

function blockTypeIcon(s: MenuSelection): IconC {
  if (s.inBulletList) return IconBulletList;
  if (s.inOrderedList) return IconOrderedList;
  if (s.inBlockquote) return IconQuote;
  if (s.blockType === 'heading') {
    return s.headingLevel === 2 ? IconHeading2 : s.headingLevel === 3 ? IconHeading3 : IconHeading1;
  }
  if (s.blockType === 'code_block') return IconCodeBlock;
  return IconParagraph;
}

type Props = {
  controller: MenuController;
  selection: MenuSelection;
  /** True in a table-cell context: cells are coordinate-addressed, not leaf
   *  blocks, so "Turn into" has nothing meaningful to convert (SKR-219). Disables
   *  the trigger rather than graying out each item — there is no applicable
   *  conversion to offer, so opening the menu would only show dead options. */
  disabled?: boolean;
};

export function BlockTypeDropdown({ controller, selection, disabled = false }: Props) {
  const StateIcon = blockTypeIcon(selection);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rich-toolbar-blocktype"
          title="Turn into"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
        >
          <StateIcon size={16} />
          <span>{blockTypeLabel(selection)}</span>
          <IconChevronDown size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ctx-menu rich-blocktype-menu"
          align="start"
          sideOffset={4}
          // Radix refocuses the trigger button on close by default, which strands the
          // caret in the toolbar after a conversion — typing goes nowhere and Space
          // reopens the menu (SKR-184 / F70). Send focus back to the editor instead,
          // where the conversion already placed the caret.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            controller.focusEditor();
          }}
        >
          {TURN_ITEMS.map((item, i) => {
            const prev = TURN_ITEMS[i - 1];
            return (
              <Fragment key={item.id}>
                {prev && prev.group !== item.group && (
                  <DropdownMenu.Separator className="ctx-sep" />
                )}
                <DropdownMenu.Item
                  className="ctx-item"
                  onSelect={() => dispatchInsert(controller, item.spec)}
                >
                  <span className="ctx-icon">
                    <item.Icon size={18} />
                  </span>
                  <span className="ctx-label">{item.label}</span>
                  {item.active(selection) && (
                    <span className="ctx-shortcut" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </DropdownMenu.Item>
              </Fragment>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
