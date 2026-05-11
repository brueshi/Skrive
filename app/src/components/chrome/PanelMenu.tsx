// Collapsed panel-toggles affordance (topbarLayout = 'collapsed').
// A single icon-button trigger opens a Radix DropdownMenu with one
// checkbox item per panel: Frontmatter, Backlinks, History.
//
// Designed for Option B of the topbar redesign. The mode toggle (Raw /
// Split / Preview) is intentionally not folded in here — it's high
// frequency and stays inline next to this trigger.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { selectActiveTab, useProjectStore } from '../../stores/project';
import { IconPanels } from '../icons/IconPanels';

export function PanelMenu() {
  const activeTab = useProjectStore(selectActiveTab);
  const backlinksPanelOpen = useProjectStore((s) => s.backlinksPanelOpen);
  const toggleBacklinksPanel = useProjectStore(
    (s) => s.toggleBacklinksPanel
  );
  const frontmatterPanelOpen = useProjectStore(
    (s) => s.frontmatterPanelOpen
  );
  const toggleFrontmatterPanel = useProjectStore(
    (s) => s.toggleFrontmatterPanel
  );
  const historyPanelOpen = useProjectStore((s) => s.historyPanelOpen);
  const toggleHistoryPanel = useProjectStore((s) => s.toggleHistoryPanel);
  const historyMode = useProjectStore((s) => s.historyMode);

  if (!activeTab) return null;

  const frontmatterCount = Object.keys(activeTab.frontmatter).length;
  const openCount =
    (frontmatterPanelOpen ? 1 : 0) +
    (backlinksPanelOpen ? 1 : 0) +
    (historyPanelOpen ? 1 : 0);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="header-icon-button panel-menu-trigger"
          aria-label="Toggle panels"
          aria-pressed={openCount > 0}
          title="Panels"
        >
          <IconPanels size={16} />
          {openCount > 0 && (
            <span className="panel-menu-dot" aria-hidden="true" />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ctx-menu panel-menu"
          align="end"
          sideOffset={4}
        >
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={frontmatterPanelOpen}
            onCheckedChange={() => toggleFrontmatterPanel()}
          >
            <span className="ctx-label">
              Frontmatter
              {frontmatterCount > 0 && (
                <span className="ctx-meta"> · {frontmatterCount}</span>
              )}
            </span>
            <span className="ctx-shortcut">⌘⇧F</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={backlinksPanelOpen}
            onCheckedChange={() => toggleBacklinksPanel()}
          >
            <span className="ctx-label">Backlinks</span>
            <span className="ctx-shortcut">⌘⇧B</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={historyPanelOpen}
            onCheckedChange={() => toggleHistoryPanel()}
          >
            <span className="ctx-label">
              History
              <span className="ctx-meta">
                {' '}
                · {historyMode === 'git' ? 'git' : 'checkpoints'}
              </span>
            </span>
            <span className="ctx-shortcut">⌘⇧H</span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
