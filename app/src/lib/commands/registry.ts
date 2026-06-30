// Single source of truth for both ⌘⇧P palette commands and the
// window-level keyboard bindings that fire them. Phase 13a.
//
// Before 13a: bindings lived in App.tsx (200+ lines of switch-style
// keydown matching), useChromeShortcuts in Header.tsx, and an editor/
// keys.ts helper. The command registry held display-only shortcut
// hints that drifted out of sync (⌘⇧W was advertised but unbound).
//
// After 13a: the registry owns the binding table. App.tsx feeds keys
// into `dispatchKey`. The cheat-sheet modal renders straight from the
// same data. Bindings carry the authoritative display string; the
// palette derives its `shortcut` hint from that.
//
// Discipline: surface-scope bindings (DiffView nav, Sidebar Enter/
// Space/Delete) are listed but not executed here — they live in their
// own surface's keydown handler because focus context matters. We
// catalogue them so the cheat-sheet has one place to look.

import { flushActiveEditor } from '../../components/editor/active-editor';
import { getActiveBlockMenu } from '../../components/editor/active-surface';
import { useProjectStore, logProjectError } from '../../stores/project';
import { notify } from '../notify';

// ============================ Types ============================

export type CommandGroup =
  | 'File'
  | 'Tabs'
  | 'View'
  | 'Insert'
  | 'Project'
  | 'Settings'
  | 'Help';

export type BindingScope = 'window' | 'editor' | 'surface';

/** Keyboard chord matched against `KeyboardEvent.code`. Code-based
 *  matching avoids the layout-dependent `key` resolution (`{` vs `[`
 *  with shift held, etc.) that the pre-13a code worked around with
 *  ad-hoc `e.code === 'BracketLeft'` branches. */
export type Chord = {
  code: string;
  /** ⌘ on macOS or Ctrl on other platforms. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display hint for the palette. Derived from the binding table at
   *  build time — do not hand-author. */
  shortcut?: string;
  /** Whether this command is currently runnable. Defaults to always. */
  when?: () => boolean;
  run: () => void | Promise<void>;
};

export type Binding = {
  chord: Chord;
  /** Human-readable display, e.g. "⌘⇧W". Authoritative; the palette
   *  reads this for its hint column. */
  display: string;
  scope: BindingScope;
  group: CommandGroup;
  label: string;
  /** When set, the binding is twinned with a palette command of the
   *  same id. Both end up in the cheat-sheet; the palette filters via
   *  `command.when`. */
  commandId?: string;
  /** Only required for `scope: 'window'` bindings. Surface bindings
   *  are dispatched by their surface's own handler. */
  run?: () => void | Promise<void>;
  when?: () => boolean;
};

/** Things the palette host owns — sibling modal openers and the like.
 *  Each is **toggle**-aware where it makes sense (closing if open,
 *  opening otherwise) so a binding press is reversible. */
export type CommandDeps = {
  toggleFileSwitcher: () => void;
  toggleCommandPalette: () => void;
  toggleSearch: () => void;
  toggleCheatSheet: () => void;
  openRename: (path: string) => void;
  openNewProject: () => void;
  openBugReport: () => void;
  openFeedback: () => void;
};

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'File',
  'Tabs',
  'View',
  'Insert',
  'Project',
  'Settings',
  'Help'
];

// ============================ Predicates ============================
//
// Shared by both commands and bindings so the two can never disagree
// about when an action is runnable. All read live state via getState()
// at invocation time.

const whenManifestOpen = () => useProjectStore.getState().manifest !== null;
const whenActiveTab = () => useProjectStore.getState().activeTabIndex >= 0;
const whenActiveTabAndManifest = () => {
  const s = useProjectStore.getState();
  return s.manifest !== null && s.activeTabIndex >= 0;
};
const whenActiveTabDirty = () => {
  const s = useProjectStore.getState();
  return (
    s.activeView === 'editor' &&
    s.activeTabIndex >= 0 &&
    (s.tabs[s.activeTabIndex]?.dirty ?? false)
  );
};
const whenMultipleTabs = () => useProjectStore.getState().tabs.length > 1;

/** The Insert commands act on the block surface, so they're runnable only when
 *  it's mounted — i.e. a document is open in the rendered (not raw / not diff)
 *  view. The active-surface slot is non-null exactly then. */
const whenBlockSurface = () => getActiveBlockMenu() != null;

/** Open the transient link affordance for the block surface's selection (or the
 *  link under its cursor). The controller no-ops when there's nothing to link. */
const openBlockLink = () => {
  getActiveBlockMenu()?.openLinkEditor();
};

// ============================ Match + dispatch ============================

export function chordMatches(e: KeyboardEvent, c: Chord): boolean {
  if (e.code !== c.code) return false;
  if ((e.metaKey || e.ctrlKey) !== !!c.mod) return false;
  if (e.shiftKey !== !!c.shift) return false;
  if (e.altKey !== !!c.alt) return false;
  return true;
}

/** Find a window-scope binding that matches the event, regardless of
 *  whether its `when` predicate currently passes. The dispatcher
 *  applies the predicate after matching. */
export function matchWindowBinding(
  e: KeyboardEvent,
  bindings: readonly Binding[]
): Binding | null {
  for (const b of bindings) {
    if (b.scope !== 'window') continue;
    if (chordMatches(e, b.chord)) return b;
  }
  return null;
}

/** Window-level dispatcher. Returns true iff a binding fired (so the
 *  caller can short-circuit). Failures from async `run` are logged but
 *  do not propagate — same posture as the palette. */
export function dispatchKey(
  e: KeyboardEvent,
  bindings: readonly Binding[]
): boolean {
  const b = matchWindowBinding(e, bindings);
  if (!b || !b.run) return false;
  if (b.when && !b.when()) return false;
  e.preventDefault();
  Promise.resolve(b.run()).catch((err) => {
    console.error(`[skrive binding ${b.commandId ?? b.label}] failed`, err);
  });
  return true;
}

// ============================ Build ============================

/** Build the full registry — both commands (palette-runnable) and
 *  bindings (keyboard-fired). Calls into `deps` for the modals the
 *  registry can't own directly.
 *
 *  Build is cheap; both the palette and the App-level dispatcher
 *  rebuild on each render so `when` predicates and toggle state stay
 *  fresh. */
export function buildRegistry(deps: CommandDeps): {
  commands: Command[];
  bindings: Binding[];
} {
  const bindings: Binding[] = [
    // ============ File ============
    {
      chord: { code: 'KeyP', mod: true },
      display: '⌘P',
      scope: 'window',
      group: 'File',
      label: 'Open file…',
      commandId: 'file.openSwitcher',
      when: whenManifestOpen,
      run: () => deps.toggleFileSwitcher()
    },
    {
      chord: { code: 'KeyF', mod: true },
      display: '⌘F',
      scope: 'window',
      group: 'File',
      label: 'Search in project…',
      commandId: 'file.search',
      when: whenManifestOpen,
      run: () => deps.toggleSearch()
    },
    {
      chord: { code: 'KeyS', mod: true },
      display: '⌘S',
      scope: 'window',
      group: 'File',
      label: 'Save',
      commandId: 'file.save',
      when: whenActiveTabDirty,
      run: async () => {
        try {
          await useProjectStore.getState().saveActiveTab();
        } catch (err) {
          logProjectError('saveActiveTab (binding)', err);
          notify.error("Couldn't save", err);
        }
      }
    },
    {
      chord: { code: 'F2' },
      display: 'F2',
      scope: 'window',
      group: 'File',
      label: 'Rename file…',
      commandId: 'file.rename',
      when: whenActiveTabAndManifest,
      run: () => {
        const s = useProjectStore.getState();
        const tab = s.tabs[s.activeTabIndex];
        if (tab) deps.openRename(tab.path);
      }
    },

    // ============ Tabs ============
    {
      chord: { code: 'KeyW', mod: true },
      display: '⌘W',
      scope: 'window',
      group: 'Tabs',
      label: 'Close tab',
      commandId: 'tabs.close',
      when: whenActiveTab,
      run: () => {
        const s = useProjectStore.getState();
        if (s.activeTabIndex >= 0) void s.closeTab(s.activeTabIndex);
      }
    },
    {
      chord: { code: 'BracketRight', mod: true, shift: true },
      display: '⌘⇧]',
      scope: 'window',
      group: 'Tabs',
      label: 'Next tab',
      commandId: 'tabs.next',
      when: whenMultipleTabs,
      run: () => {
        const s = useProjectStore.getState();
        if (s.tabs.length === 0) return;
        s.switchTab((s.activeTabIndex + 1) % s.tabs.length);
      }
    },
    {
      chord: { code: 'BracketLeft', mod: true, shift: true },
      display: '⌘⇧[',
      scope: 'window',
      group: 'Tabs',
      label: 'Previous tab',
      commandId: 'tabs.prev',
      when: whenMultipleTabs,
      run: () => {
        const s = useProjectStore.getState();
        if (s.tabs.length === 0) return;
        s.switchTab(
          (s.activeTabIndex - 1 + s.tabs.length) % s.tabs.length
        );
      }
    },

    // ============ View ============
    {
      chord: { code: 'BracketLeft', mod: true },
      display: '⌘[',
      scope: 'window',
      group: 'View',
      label: 'Toggle sidebar',
      commandId: 'view.toggleSidebar',
      when: whenManifestOpen,
      run: () => useProjectStore.getState().toggleSidebar()
    },
    {
      chord: { code: 'KeyF', mod: true, shift: true },
      display: '⌘⇧F',
      scope: 'window',
      group: 'View',
      label: 'Toggle frontmatter panel',
      commandId: 'view.toggleFrontmatter',
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleFrontmatterPanel()
    },
    {
      chord: { code: 'KeyB', mod: true, shift: true },
      display: '⌘⇧B',
      scope: 'window',
      group: 'View',
      label: 'Toggle backlinks panel',
      commandId: 'view.toggleBacklinks',
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleBacklinksPanel()
    },
    {
      chord: { code: 'KeyH', mod: true, shift: true },
      display: '⌘⇧H',
      scope: 'window',
      group: 'View',
      label: 'Toggle version history panel',
      commandId: 'view.toggleHistory',
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleHistoryPanel()
    },
    {
      chord: { code: 'KeyE', mod: true, shift: true },
      display: '⌘⇧E',
      scope: 'window',
      group: 'View',
      label: 'Toggle source view',
      commandId: 'view.toggleSource',
      when: whenActiveTab,
      // Flush-then-flip: drain the outgoing surface's pending edits into the
      // canonical body, then toggle the raw source view. Both are synchronous
      // store writes inside one keydown handler, so React re-renders once and
      // the incoming view mounts reading the fully-flushed body — no edit loss.
      run: () => {
        flushActiveEditor();
        const s = useProjectStore.getState();
        const tab = s.tabs[s.activeTabIndex];
        if (tab) s.setTabRawView(s.activeTabIndex, !tab.rawView);
      }
    },

    // ============ Project ============
    {
      chord: { code: 'KeyO', mod: true },
      display: '⌘O',
      scope: 'window',
      group: 'Project',
      label: 'Open project…',
      commandId: 'project.open',
      run: () => {
        void useProjectStore
          .getState()
          .openProjectFromDialog()
          .catch((err) =>
            logProjectError('openProjectFromDialog (binding)', err)
          );
      }
    },
    // ⌘⇧W — close project. Phase 13a fix: previously advertised in the
    // palette + context menu but unbound. Pressing it did nothing.
    {
      chord: { code: 'KeyW', mod: true, shift: true },
      display: '⌘⇧W',
      scope: 'window',
      group: 'Project',
      label: 'Close project',
      commandId: 'project.close',
      when: whenManifestOpen,
      run: async () => {
        try {
          await useProjectStore.getState().closeProject();
        } catch (err) {
          logProjectError('closeProject (binding)', err);
          notify.error("Couldn't close project", err);
        }
      }
    },

    // ============ Settings ============
    {
      chord: { code: 'Comma', mod: true },
      display: '⌘,',
      scope: 'window',
      group: 'Settings',
      label: 'Open settings',
      commandId: 'settings.toggle',
      when: whenManifestOpen,
      run: () => useProjectStore.getState().toggleSettings()
    },

    // ============ Help ============
    // ⌘⇧P opens the palette itself, so listing it as a palette command
    // would be circular. Bind-only; the cheat-sheet still picks it up.
    {
      chord: { code: 'KeyP', mod: true, shift: true },
      display: '⌘⇧P',
      scope: 'window',
      group: 'Help',
      label: 'Command palette',
      when: whenManifestOpen,
      run: () => deps.toggleCommandPalette()
    },
    {
      chord: { code: 'Slash', mod: true },
      display: '⌘/',
      scope: 'window',
      group: 'Help',
      label: 'Keyboard shortcuts',
      commandId: 'help.cheatSheet',
      run: () => deps.toggleCheatSheet()
    },

    // ============ Surface (catalogued only — runs in surface) ============
    // These bindings live in their surface's own keydown handler.
    // Listed here so the cheat-sheet has one place to look. Their
    // `run`s are intentionally absent.
    {
      chord: { code: 'Escape' },
      display: 'Esc',
      scope: 'surface',
      group: 'View',
      label: 'Close panel / dismiss modal'
    },
    {
      chord: { code: 'KeyN' },
      display: 'n / j',
      scope: 'surface',
      group: 'View',
      label: 'Diff: next change'
    },
    {
      chord: { code: 'KeyP' },
      display: 'p / k',
      scope: 'surface',
      group: 'View',
      label: 'Diff: previous change'
    }
  ];

  // Index displays so command entries stay in sync without hand-authoring.
  const displayFor = new Map<string, string>();
  for (const b of bindings) {
    if (b.commandId) displayFor.set(b.commandId, b.display);
  }
  const get = (id: string): string | undefined => displayFor.get(id);

  const commands: Command[] = [
    // ============ File ============
    {
      id: 'file.openSwitcher',
      label: 'Open file…',
      group: 'File',
      shortcut: get('file.openSwitcher'),
      when: whenManifestOpen,
      run: () => deps.toggleFileSwitcher()
    },
    {
      id: 'file.search',
      label: 'Search in project…',
      group: 'File',
      shortcut: get('file.search'),
      when: whenManifestOpen,
      run: () => deps.toggleSearch()
    },
    {
      id: 'file.save',
      label: 'Save',
      group: 'File',
      shortcut: get('file.save'),
      when: whenActiveTabDirty,
      run: async () => {
        try {
          await useProjectStore.getState().saveActiveTab();
        } catch (err) {
          logProjectError('saveActiveTab (palette)', err);
          notify.error("Couldn't save", err);
        }
      }
    },
    {
      id: 'file.rename',
      label: 'Rename file…',
      group: 'File',
      shortcut: get('file.rename'),
      when: whenActiveTabAndManifest,
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
      shortcut: get('tabs.close'),
      when: whenActiveTab,
      run: () => {
        const s = useProjectStore.getState();
        if (s.activeTabIndex >= 0) void s.closeTab(s.activeTabIndex);
      }
    },
    {
      id: 'tabs.next',
      label: 'Next tab',
      group: 'Tabs',
      shortcut: get('tabs.next'),
      when: whenMultipleTabs,
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
      shortcut: get('tabs.prev'),
      when: whenMultipleTabs,
      run: () => {
        const s = useProjectStore.getState();
        if (s.tabs.length === 0) return;
        s.switchTab(
          (s.activeTabIndex - 1 + s.tabs.length) % s.tabs.length
        );
      }
    },

    // ============ View ============
    {
      id: 'view.toggleSidebar',
      label: 'Toggle sidebar',
      group: 'View',
      shortcut: get('view.toggleSidebar'),
      when: whenManifestOpen,
      run: () => useProjectStore.getState().toggleSidebar()
    },
    {
      id: 'view.toggleFrontmatter',
      label: 'Toggle frontmatter panel',
      group: 'View',
      shortcut: get('view.toggleFrontmatter'),
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleFrontmatterPanel()
    },
    {
      id: 'view.toggleBacklinks',
      label: 'Toggle backlinks panel',
      group: 'View',
      shortcut: get('view.toggleBacklinks'),
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleBacklinksPanel()
    },
    {
      id: 'view.toggleHistory',
      label: 'Toggle version history panel',
      group: 'View',
      shortcut: get('view.toggleHistory'),
      when: whenActiveTab,
      run: () => useProjectStore.getState().toggleHistoryPanel()
    },
    {
      id: 'view.toggleSource',
      label: 'Toggle source view',
      group: 'View',
      shortcut: get('view.toggleSource'),
      when: whenActiveTab,
      run: () => {
        flushActiveEditor();
        const s = useProjectStore.getState();
        const tab = s.tabs[s.activeTabIndex];
        if (tab) s.setTabRawView(s.activeTabIndex, !tab.rawView);
      }
    },

    // ============ Insert (block surface affordances) ============
    // Palette twins of the toolbar / slash menu, gated to the mounted block
    // surface and dispatched through its MenuController. Block conversions act
    // on the cursor's block; the divider/table insert relative to it.
    ...[1, 2, 3].map<Command>((level) => ({
      id: `insert.heading${level}`,
      label: `Heading ${level}`,
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.setHeading(level);
      }
    })),
    {
      id: 'insert.bulletList',
      label: 'Bulleted list',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.toggleBulletList();
      }
    },
    {
      id: 'insert.orderedList',
      label: 'Numbered list',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.toggleOrderedList();
      }
    },
    {
      id: 'insert.quote',
      label: 'Quote',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.toggleBlockquote();
      }
    },
    {
      id: 'insert.codeBlock',
      label: 'Code block',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.setCodeBlock();
      }
    },
    {
      id: 'insert.divider',
      label: 'Divider',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.insertDivider();
      }
    },
    {
      id: 'insert.table',
      label: 'Table',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => {
        getActiveBlockMenu()?.insertTable();
      }
    },
    {
      id: 'insert.link',
      label: 'Link',
      group: 'Insert',
      when: whenBlockSurface,
      run: () => openBlockLink()
    },

    // ============ Project ============
    {
      id: 'project.open',
      label: 'Open project…',
      group: 'Project',
      shortcut: get('project.open'),
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
      shortcut: get('project.close'),
      when: whenManifestOpen,
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
      shortcut: get('settings.toggle'),
      when: whenManifestOpen,
      run: () => useProjectStore.getState().toggleSettings()
    },

    // ============ Help ============
    {
      id: 'help.cheatSheet',
      label: 'Keyboard shortcuts',
      group: 'Help',
      shortcut: get('help.cheatSheet'),
      run: () => deps.toggleCheatSheet()
    },
    {
      id: 'help.reportBug',
      label: 'Report a bug…',
      group: 'Help',
      run: () => deps.openBugReport()
    },
    {
      id: 'help.sendFeedback',
      label: 'Send feedback…',
      group: 'Help',
      run: () => deps.openFeedback()
    }
  ];

  return { commands, bindings };
}

/** Backwards-compatible alias for surfaces that only need the palette
 *  command list. Built on top of `buildRegistry`. */
export function buildCommands(deps: CommandDeps): Command[] {
  return buildRegistry(deps).commands;
}
