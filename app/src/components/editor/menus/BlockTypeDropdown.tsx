// The "Turn into" block-type control, shared by the fixed toolbar and the
// selection bubble so the two never drift. Mutually-exclusive textblock types
// (Text / Heading 1-3) live here; wrap-style toggles (list, quote) stay as
// their own buttons because they nest rather than replace, and Code block is
// a dedicated toolbar button (SKR-207) — it keeps its trigger icon/label here
// only so the control still reflects state when the caret sits in one.
// Driven by the editor-agnostic MenuController.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { MenuController, MenuBlockType } from './controller';
import {
  IconChevronDown,
  IconParagraph,
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconCodeBlock
} from './toolbar-icons';

const HEADING_LEVELS = [
  [1, IconHeading1],
  [2, IconHeading2],
  [3, IconHeading3]
] as const;

export function blockTypeLabel(blockType: MenuBlockType, headingLevel: number | null): string {
  if (blockType === 'heading') return `Heading ${headingLevel ?? 1}`;
  if (blockType === 'code_block') return 'Code block';
  return 'Text';
}

function blockTypeIcon(blockType: MenuBlockType, headingLevel: number | null) {
  if (blockType === 'heading') {
    const entry = HEADING_LEVELS.find(([level]) => level === (headingLevel ?? 1));
    return entry ? entry[1] : IconHeading1;
  }
  if (blockType === 'code_block') return IconCodeBlock;
  return IconParagraph;
}

type Props = {
  controller: MenuController;
  blockType: MenuBlockType;
  headingLevel: number | null;
};

export function BlockTypeDropdown({ controller, blockType, headingLevel }: Props) {
  const StateIcon = blockTypeIcon(blockType, headingLevel);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rich-toolbar-blocktype"
          title="Turn into"
          onMouseDown={(e) => e.preventDefault()}
        >
          <StateIcon size={16} />
          <span>{blockTypeLabel(blockType, headingLevel)}</span>
          <IconChevronDown size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ctx-menu rich-blocktype-menu" align="start" sideOffset={4}>
          <DropdownMenu.Item className="ctx-item" onSelect={() => controller.setParagraph()}>
            <span className="ctx-icon">
              <IconParagraph size={18} />
            </span>
            <span className="ctx-label">Text</span>
          </DropdownMenu.Item>
          {HEADING_LEVELS.map(([level, HeadingIcon]) => (
            <DropdownMenu.Item key={level} className="ctx-item" onSelect={() => controller.setHeading(level)}>
              <span className="ctx-icon">
                <HeadingIcon size={18} />
              </span>
              <span className="ctx-label">Heading {level}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
