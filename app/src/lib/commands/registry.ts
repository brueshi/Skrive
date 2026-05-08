// Command registry for the ⌘⇧P palette (Phase 11).
//
// Commands are pure functions of app state plus a small `deps` bag for
// side effects the palette host owns (opening sibling modals, surfacing
// toasts, etc.). Each carries a `when` predicate the palette evaluates
// at render time so disabled commands get filtered out — listing
// actions the user can't run adds noise, and the writer-first ethos is
// to show only what's actionable right now.
//
// Scope discipline: this is internal-only. Public command APIs are a
// v1.x consideration once the patterns settle.

import type { LayoutMode } from '../../components/editor/SplitView';

export type CommandGroup =
  | 'File'
  | 'View'
  | 'Project'
  | 'Tabs'
  | 'Settings';

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display-only shortcut hint. Bindings live in App.tsx. */
  shortcut?: string;
  /** Whether this command is currently runnable. Defaults to always. */
  when?: () => boolean;
  run: () => void | Promise<void>;
};

/** Things the palette host owns and the registry can't pull from a
 *  store singleton — sibling modal openers, the close-on-run hook,
 *  etc. Keep this tight; avoid dumping the world in here. */
export type CommandDeps = {
  openFileSwitcher: () => void;
  openSearch: () => void;
  openRename: (path: string) => void;
  openNewProject: () => void;
};

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'File',
  'Tabs',
  'View',
  'Project',
  'Settings'
];

// ============================ Build ============================
//
// Each command's `when` / `run` reads via getState() so the predicate
// reflects "right now" — not a snapshot from build time. Builders run
// once per palette open; consulting state during that build would
// freeze the resulting list against in-flight changes.

import { useProjectStore, logProjectError } from '../../stores/project';
import { notify } from '../notify';

export function buildCommands(deps: CommandDeps): Command[] {
  const layoutSetters: Array<{ mode: LayoutMode; shortcut: string }> = [
    { mode: 'raw', shortcut: '⌘1' },
    { mode: 'split', shortcut: '⌘2' },
    { mode: 'preview', shortcut: '⌘3' }
  ];

  return [
    // ============ File ============
    {
      id: 'file.openSwitcher',
      label: 'Open file…',
      group: 'File',
      shortcut: '⌘P',
      when: () => useProjectStore.getState().manifest !== null,
      run: () => deps.openFileSwitcher()
    },
    {
      id: 'file.search',
      label: 'Search in project…',
      group: 'File',
      shortcut: '⌘F',
      when: () => useProjectStore.getState().manifest !== null,
      run: () => deps.openSearch()
    },
    {
      id: 'file.save',
      label: 'Save',
      group: 'File',
      shortcut: '⌘S',
      when: () => {
        const s = useProjectStore.getState();
        return (
          s.activeView === 'editor' &&
          s.activeTabIndex >= 0 &&
          (s.tabs[s.activeTabIndex]?.dirty ?? false)
        );
      },
      run: async () => {
        try {
          await useProjectStore.getState().saveActiveTab();
        } catch (err) {
          logProjectError('saveActiveTab (palette)', err);
          notify.error('Failed to save', err);
        }
      }
    },
    {
      id: 'file.rename',
      label: 'Rename file…',
      group: 'File',
      shortcut: 'F2',
      when: () => {
        const s = useProjectStore.getState();
        return (
          s.activeView === 'editor' &&
          s.activeTabIndex >= 0 &&
          s.tabs[s.activeTabIndex] !== undefined
        );
      },
      run: () => {
        const s = useProjectStore.getState();
        const tab = s.tabs[s.activeTabIndex];
        if (tab) deps.openRename(tab.path);
      }
    },

    // ============ Tabs ============
    {
      id: 'tabs.close',
      label: 'Close tab',
      group: 'Tabs',
      shortcut: '⌘W',
      when: () => useProjectStore.getState().activeTabIndex >= 0,
      run: () => {
        const s = useProjectStore.getState();
        if (s.activeTabIndex >= 0) void s.closeTab(s.activeTabIndex);
      }
    },
    {
      id: 'tabs.next',
      label: 'Next tab',
      group: 'Tabs',
      shortcut: '⌘⇧]',
      when: () => useProjectStore.getState().tabs.length > 1,
      run: () => {
        const s = useProjectStore.getState();
        if (s.tabs.length === 0) return;
        s.switchTab((s.activeTabIndex + 1) % s.tabs.length);
      }
    },
    {
      id: 'tabs.prev',
      label: 'Previous tab',
      group: 'Tabs',
      shortcut: '⌘⇧[',
      when: () => useProjectStore.getState().tabs.length > 1,
      run: () => {
        const s = useProjectStore.getState();
        if (s.tabs.length === 0) return;
        s.switchTab(
          (s.activeTabIndex - 1 + s.tabs.length) % s.tabs.length
        );
      }
    },

    // ============ View ============
    ...layoutSetters.map((entry) => ({
      id: `view.layout.${entry.mode}`,
      label: `Layout: ${capitalize(entry.mode)}`,
      group: 'View' as const,
      shortcut: entry.shortcut,
      when: () => useProjectStore.getState().activeTabIndex >= 0,
      run: () => {
        const s = useProjectStore.getState();
        if (s.activeTabIndex >= 0) {
          s.setTabLayoutMode(s.activeTabIndex, entry.mode);
        }
      }
    })),
    {
      id: 'view.toggleSidebar',
      label: 'Toggle sidebar',
      group: 'View',
      shortcut: '⌘B',
      when: () => useProjectStore.getState().manifest !== null,
      run: () => useProjectStore.getState().toggleSidebar()
    },
    {
      id: 'view.toggleFrontmatter',
      label: 'Toggle frontmatter panel',
      group: 'View',
      shortcut: '⌘⇧F',
      when: () => useProjectStore.getState().activeTabIndex >= 0,
      run: () => useProjectStore.getState().toggleFrontmatterPanel()
    },
    {
      id: 'view.toggleBacklinks',
      label: 'Toggle backlinks panel',
      group: 'View',
      shortcut: '⌘⇧B',
      when: () => useProjectStore.getState().activeTabIndex >= 0,
      run: () => useProjectStore.getState().toggleBacklinksPanel()
    },
    {
      id: 'view.toggleHistory',
      label: 'Toggle version history panel',
      group: 'View',
      shortcut: '⌘⇧H',
      when: () => useProjectStore.getState().activeTabIndex >= 0,
      run: () => useProjectStore.getState().toggleHistoryPanel()
    },

    // ============ Project ============
    {
      id: 'project.open',
      label: 'Open project…',
      group: 'Project',
      shortcut: '⌘O',
      run: () => {
        void useProjectStore
          .getState()
          .openProjectFromDialog()
          .catch((err) => {
            logProjectError('openProjectFromDialog (palette)', err);
            notify.error("Couldn't open project", err);
          });
      }
    },
    {
      id: 'project.new',
      label: 'New project…',
      group: 'Project',
      run: () => deps.openNewProject()
    },
    {
      id: 'project.close',
      label: 'Close project',
      group: 'Project',
      shortcut: '⌘⇧W',
      when: () => useProjectStore.getState().manifest !== null,
      run: async () => {
        try {
          await useProjectStore.getState().closeProject();
        } catch (err) {
          logProjectError('closeProject (palette)', err);
          notify.error("Couldn't close project", err);
        }
      }
    },
    {
      id: 'project.revealUserData',
      label: 'Reveal preferences directory',
      group: 'Project',
      run: () => {
        void window.skrive.persistence
          .revealUserData()
          .catch((err) => logProjectError('revealUserData', err));
      }
    },

    // ============ Settings ============
    {
      id: 'settings.toggle',
      label: 'Open settings',
      group: 'Settings',
      shortcut: '⌘,',
      when: () => useProjectStore.getState().manifest !== null,
      run: () => useProjectStore.getState().toggleSettings()
    },
  ];
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
