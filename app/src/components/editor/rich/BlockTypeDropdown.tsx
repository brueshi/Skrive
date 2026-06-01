// The "Turn into" block-type control — a labelled trigger that converts the
// current textblock between Text / Heading 1-3 / Code block. Shared by the fixed
// toolbar and the selection bubble so the two never drift. The mutually-exclusive
// textblock types live here; wrap-style toggles (list, quote) stay as their own
// buttons because they nest rather than replace.

import { useCallback } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { setParagraph, setHeading, setCodeBlock } from '../../../lib/projection/commands';
import { IconChevronDown } from './toolbar-icons';

export function blockTypeLabel(blockType: string, headingLevel: number | null): string {
  if (blockType === 'heading') return `Heading ${headingLevel ?? 1}`;
  if (blockType === 'code_block') return 'Code block';
  return 'Text';
}

type Props = {
  view: EditorView;
  blockType: string;
  headingLevel: number | null;
};

export function BlockTypeDropdown({ view, blockType, headingLevel }: Props) {
  const run = useCallback(
    (cmd: Command) => {
      cmd(view.state, view.dispatch, view);
      view.focus();
    },
    [view]
  );

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
        <DropdownMenu.Content
          className="ctx-menu rich-blocktype-menu"
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Item className="ctx-item" onSelect={() => run(setParagraph)}>
            <span className="ctx-label">Text</span>
          </DropdownMenu.Item>
          {[1, 2, 3].map((level) => (
            <DropdownMenu.Item
              key={level}
              className="ctx-item"
              onSelect={() => run(setHeading(level))}
            >
              <span className="ctx-label">Heading {level}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item className="ctx-item" onSelect={() => run(setCodeBlock)}>
            <span className="ctx-label">Code block</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
