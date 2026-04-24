// Command registry for the ⌘⇧P palette. Commands are functions of
// app state plus a small `deps` bag holding the things we can't pull
// from a singleton — currently just the autosave hooks owned by
// +page.svelte. Everything else (project store, preferences,
// project-actions, updater) lives behind imports here.
//
// Commands carry a `when` predicate that the palette evaluates at
// render time so disabled commands (e.g. "Toggle frontmatter panel"
// while no file is active) get filtered out of the list. We don't
// keep them in a dimmed state — listing actions the user can't run
// adds noise, and the writer-first ethos is to show only what's
// actionable right now.
//
// Scope discipline: this is internal-only. We don't ship a public API
// for users to register commands. Per polish-track-plan, that's a
// v1.x consideration once the patterns are settled.

import { project } from "$lib/stores/project.svelte";
import { preferences } from "$lib/stores/preferences.svelte";
import { flushSave } from "$lib/persistence/autosave";
import {
  openProjectFromPicker,
  closeCurrentProject,
} from "$lib/project-actions";
import { checkForUpdatesManual } from "$lib/updater";
import { notify } from "$lib/stores/notifications.svelte";
import { formatError } from "$lib/errors";

export type CommandGroup =
  | "File"
  | "View"
  | "Project"
  | "Settings"
  | "Tabs";

export type Command = {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display-only shortcut hint. Bindings still live in +page.svelte. */
  shortcut?: string;
  /** Whether this command is currently runnable. Defaults to always. */
  when?: () => boolean;
  run: () => void | Promise<void>;
};

export type CommandDeps = {
  autoSaveHooks: {
    onSaved: (path: string) => void;
    onError: (path: string, err: unknown) => void;
  };
  /** How the palette host opens the file switcher (it owns that state). */
  openFileSwitcher: () => void;
};

export function buildCommands(deps: CommandDeps): Command[] {
  return [
    // ============ File ============
    {
      id: "file.openSwitcher",
      label: "Open file…",
      group: "File",
      shortcut: "⌘P",
      when: () => project.hasProject,
      run: () => deps.openFileSwitcher(),
    },
    {
      id: "file.save",
      label: "Save",
      group: "File",
      shortcut: "⌘S",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: async () => {
        const tab = project.activeTab;
        if (!tab) return;
        try {
          await flushSave(tab.path, deps.autoSaveHooks);
        } catch (err) {
          notify.error(`Couldn't save ${tab.path}: ${formatError(err)}`, err);
        }
      },
    },
    {
      id: "file.rename",
      label: "Rename file…",
      group: "File",
      shortcut: "F2",
      when: () =>
        project.activeView === "file" &&
        project.activeTab !== null &&
        project.renameModalPath === null,
      run: () => {
        const tab = project.activeTab;
        if (!tab) return;
        project.openRenameModal(tab.path);
      },
    },
    {
      id: "file.search",
      label: "Search in project…",
      group: "File",
      shortcut: "⌘F",
      when: () => project.hasProject,
      run: () => {
        // Like the menu's command-palette entry, dispatch a window
        // event so +page.svelte's existing toggle logic wins. Avoids
        // hoisting `searchModalOpen` into a global store.
        window.dispatchEvent(new CustomEvent("skrive:open-search"));
      },
    },

    // ============ View ============
    {
      id: "view.toggleSidebar",
      label: "Toggle sidebar",
      group: "View",
      shortcut: "⌘[",
      when: () => project.hasProject,
      run: () => project.toggleSidebar(),
    },
    {
      id: "view.layoutRaw",
      label: "Layout: Raw",
      group: "View",
      shortcut: "⌘1",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: () => project.setLayoutMode("raw"),
    },
    {
      id: "view.layoutSplit",
      label: "Layout: Split",
      group: "View",
      shortcut: "⌘2",
      when: () =>
        project.activeView === "file" &&
        project.activeTab !== null &&
        project.activeTab.layoutMode !== "diff-raw" &&
        project.activeTab.layoutMode !== "diff-preview",
      run: () => project.setLayoutMode("split"),
    },
    {
      id: "view.layoutPreview",
      label: "Layout: Preview",
      group: "View",
      shortcut: "⌘3",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: () => project.setLayoutMode("preview"),
    },
    {
      id: "view.toggleFrontmatter",
      label: "Toggle frontmatter panel",
      group: "View",
      shortcut: "⌘⇧F",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: () => project.toggleFrontmatterPanel(),
    },
    {
      id: "view.toggleBacklinks",
      label: "Toggle backlinks panel",
      group: "View",
      shortcut: "⌘⇧B",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: () => project.toggleBacklinksPanel(),
    },
    {
      id: "view.toggleHistory",
      label: "Toggle version history",
      group: "View",
      shortcut: "⌘⇧H",
      when: () => project.activeView === "file" && project.activeTab !== null,
      run: () => project.toggleHistoryPanel(),
    },
    {
      id: "view.toggleDictionary",
      label: "Toggle personal dictionary",
      group: "View",
      shortcut: "⌘⇧D",
      run: () => preferences.toggleDictionaryPanel(),
    },

    // ============ Tabs ============
    {
      id: "tabs.next",
      label: "Next tab",
      group: "Tabs",
      shortcut: "⌘⇧]",
      when: () => project.tabs.length > 0,
      run: () => project.cycleActiveTab(1),
    },
    {
      id: "tabs.previous",
      label: "Previous tab",
      group: "Tabs",
      shortcut: "⌘⇧[",
      when: () => project.tabs.length > 0,
      run: () => project.cycleActiveTab(-1),
    },

    // ============ Project ============
    {
      id: "project.open",
      label: "Open project…",
      group: "Project",
      shortcut: "⌘O",
      run: () => void openProjectFromPicker(),
    },
    {
      id: "project.close",
      label: "Close project",
      group: "Project",
      shortcut: "⌘⇧W",
      when: () => project.hasProject,
      run: () => void closeCurrentProject(deps.autoSaveHooks),
    },
    {
      id: "project.checkForUpdates",
      label: "Check for updates…",
      group: "Project",
      run: () => void checkForUpdatesManual(),
    },

    // ============ Settings ============
    {
      id: "settings.open",
      label: "Open Settings",
      group: "Settings",
      shortcut: "⌘,",
      when: () => project.hasProject,
      run: () => project.openSettings(),
    },
    {
      id: "settings.close",
      label: "Close Settings",
      group: "Settings",
      when: () => project.settingsOpen && project.activeView === "settings",
      run: () => project.closeSettings(),
    },
  ];
}
