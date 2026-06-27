// The "Turn into" block-type control, shared by the fixed toolbar and the
// selection bubble so the two never drift. Mutually-exclusive textblock types
// (Text / Heading 1-3 / Code block) live here; wrap-style toggles (list, quote)
// stay as their own buttons because they nest rather than replace. Driven by the
// editor-agnostic MenuController.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { MenuController, MenuBlockType } from './controller';
import { IconChevronDown } from './toolbar-icons';

export function blockTypeLabel(blockType: MenuBlockType, headingLevel: number | null): string {
  if (blockType === 'heading') return `Heading ${headingLevel ?? 1}`;
  if (blockType === 'code_block') return 'Code block';
  return 'Text';
}

type Props = {
  controller: MenuController;
  blockType: MenuBlockType;
  headingLevel: number | null;
};

export function BlockTypeDropdown({ controller, blockType, headingLevel }: Props) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rich-toolbar-blocktype"
          title="Turn into"
          onMouseDown={(e) => e.preventDefault()}
        >
          <span>{blockTypeLabel(blockType, headingLevel)}</span>
          <IconChevronDown size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ctx-menu rich-blocktype-menu" align="start" sideOffset={4}>
          <DropdownMenu.Item className="ctx-item" onSelect={() => controller.setParagraph()}>
            <span className="ctx-label">Text</span>
          </DropdownMenu.Item>
          {[1, 2, 3].map((level) => (
            <DropdownMenu.Item key={level} className="ctx-item" onSelect={() => controller.setHeading(level)}>
              <span className="ctx-label">Heading {level}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item className="ctx-item" onSelect={() => controller.setCodeBlock()}>
            <span className="ctx-label">Code block</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
