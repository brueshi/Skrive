// The View menu (SKR-243, chrome-affordance-grammar §1 home 4 + rule 5): the
// standing home for view toggles. A single icon-button trigger opens a Radix
// DropdownMenu with one checkbox per panel — Frontmatter, Backlinks, History.
//
// This generalizes the old collapsed-topbar PanelMenu: the grammar routes every
// mode/panel toggle here (mirrored by a palette command + hotkey), so Focus mode
// (SKR-52) and future view toggles join this list rather than growing the toolbar.
// The Raw / Split / Preview mode cycle stays inline next to this trigger — it is
// high-frequency and layout-specific, not a checkbox toggle.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconButton } from '../ui/IconButton';
import {
  selectLiveDoc,
  selectLiveDocLineMeasure,
  useProjectStore
} from '../../stores/project';
import { IconPanels } from '../icons/IconPanels';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { Tooltip } from '../ui/Tooltip';
import { usePreferencesStore } from '../../stores/preferences';
import type { LineMeasure } from '@skrive/shared';

/** Radio rows for the per-document measure override. `null` = follow the
 *  global Settings default. */
const DOC_MEASURE_OPTIONS: ReadonlyArray<{
  value: LineMeasure | null;
  label: string;
}> = [
  { value: null, label: 'Default' },
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' }
];

export function ViewMenu() {
  const activeTab = useProjectStore(selectLiveDoc);
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
  const docLineMeasure = useProjectStore(selectLiveDocLineMeasure);
  const setLiveDocLineMeasure = useProjectStore(
    (s) => s.setLiveDocLineMeasure
  );
  const showMeasureRule = usePreferencesStore((s) => s.showMeasureRule);
  const setShowMeasureRule = usePreferencesStore(
    (s) => s.setShowMeasureRule
  );
  const showRuledLines = usePreferencesStore((s) => s.showRuledLines);
  const setShowRuledLines = usePreferencesStore(
    (s) => s.setShowRuledLines
  );

  if (!activeTab) return null;

  // The override persists in folio docMeta / md frontmatter; text and
  // view docs have neither home, so the row hides for them.
  const hasMeasureHome =
    activeTab.mode === 'markdown' || activeTab.mode === 'rich';

  const frontmatterCount = Object.keys(activeTab.frontmatter).length;
  const openCount =
    (frontmatterPanelOpen ? 1 : 0) +
    (backlinksPanelOpen ? 1 : 0) +
    (historyPanelOpen ? 1 : 0);

  return (
    <DropdownMenu.Root>
      <Tooltip label="View" side="bottom">
        <DropdownMenu.Trigger asChild>
          <IconButton
            size="lg"
            className="view-menu-trigger"
            aria-label="View options"
            aria-pressed={openCount > 0}
          >
            <IconPanels size={16} />
            {openCount > 0 && (
              <span className="view-menu-dot" aria-hidden="true" />
            )}
          </IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ctx-menu view-menu"
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
            <span className="ctx-shortcut">{platformShortcut('⌘⇧F')}</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={backlinksPanelOpen}
            onCheckedChange={() => toggleBacklinksPanel()}
          >
            <span className="ctx-label">Backlinks</span>
            <span className="ctx-shortcut">{platformShortcut('⌘⇧B')}</span>
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
            <span className="ctx-shortcut">{platformShortcut('⌘⇧H')}</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="ctx-sep" />
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={showMeasureRule}
            onCheckedChange={() => setShowMeasureRule(!showMeasureRule)}
          >
            <span className="ctx-label">Measure rule</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className="ctx-item"
            checked={showRuledLines}
            onCheckedChange={() => setShowRuledLines(!showRuledLines)}
          >
            <span className="ctx-label">Ruled lines</span>
          </DropdownMenu.CheckboxItem>
          {hasMeasureHome && (
            <>
              <DropdownMenu.Separator className="ctx-sep" />
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="ctx-item">
                  <span className="ctx-label">
                    Document measure
                    {docLineMeasure && (
                      <span className="ctx-meta"> · {docLineMeasure}</span>
                    )}
                  </span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    className="ctx-menu"
                    sideOffset={2}
                  >
                    <DropdownMenu.RadioGroup
                      value={docLineMeasure ?? 'default'}
                      onValueChange={(v) =>
                        setLiveDocLineMeasure(
                          v === 'default' ? null : (v as LineMeasure)
                        )
                      }
                    >
                      {DOC_MEASURE_OPTIONS.map((opt) => (
                        <DropdownMenu.RadioItem
                          key={opt.label}
                          className="ctx-item"
                          value={opt.value ?? 'default'}
                        >
                          <span className="ctx-label">{opt.label}</span>
                          <DropdownMenu.ItemIndicator>
                            <span
                              className="ctx-radio-dot"
                              aria-hidden="true"
                            />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
