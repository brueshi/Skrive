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
import { INSERT_CATALOG, dispatchInsert } from '../../components/editor/menus/insert-catalog';
import { useProjectStore, logProjectError } from '../../stores/project';
import { usePreferencesStore } from '../../stores/preferences';
import { MEASURE_CH } from '../typography-css';
import { LINE_MEASURE_CUSTOM_MAX_CH } from '@skrive/shared';
import { useFindStore } from '../../stores/find';
import { peekVisit } from '../../stores/working-set';
import { fileMode } from '../../stores/save';
import { EXPORT_FORMATS } from '../export';
import { importKind } from '../import';
import { notify } from '../notify';

// ============================ Types ============================

export type CommandGroup =
  | 'File'
  | 'Edit'
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
  'Edit',
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
const whenLiveDoc = () => useProjectStore.getState().liveDoc !== null;
/** The per-document measure override persists in folio docMeta or `.md`
 *  frontmatter — text/view docs have neither, so the commands hide. */
const whenDocMeasureHome = () => {
  const doc = useProjectStore.getState().liveDoc;
  return doc !== null && (doc.mode === 'markdown' || doc.mode === 'rich');
};

const MEASURE_NUDGE_CH = 5;

/** Step the global measure by one stepper notch, entering Custom from a
 *  preset seeded at that preset's ch so the first nudge feels continuous.
 *  Widening from Full no-ops — Full is already uncapped, and dropping to
 *  the custom ceiling would narrow the column. */
function nudgeMeasure(deltaCh: number): void {
  const p = usePreferencesStore.getState();
  if (p.lineMeasure === 'full') {
    if (deltaCh > 0) return;
    p.setLineMeasureCustomCh(LINE_MEASURE_CUSTOM_MAX_CH);
    return;
  }
  const seed =
    p.lineMeasure === 'custom'
      ? p.lineMeasureCustomCh
      : MEASURE_CH[p.lineMeasure];
  p.setLineMeasureCustomCh(seed + deltaCh);
}
/** Focus mode's Escape exit. Gated on the mode being on AND on no dismissable
 *  layer being open: Radix dialogs and menus handle Escape without calling
 *  preventDefault on the native event, so dispatchKey's defaultPrevented guard
 *  can't see them — dismissing the palette would otherwise also drop the mode.
 *  A live layer is always in the DOM, so its presence is the reliable tell. */
const whenFocusMode = () =>
  useProjectStore.getState().focusMode &&
  document.querySelector('[role="dialog"],[role="menu"]') === null;

const whenLiveDocAndManifest = () => {
  const s = useProjectStore.getState();
  return s.manifest !== null && s.liveDoc !== null;
};
const whenLiveDocDirty = () => {
  const s = useProjectStore.getState();
  return s.activeView === 'editor' && (s.liveDoc?.dirty ?? false);
};
/** ⌘⇧[ / ⌘⇧] walk the trail of document visits (SKR-243). */
const whenTrailBack = () => {
  const s = useProjectStore.getState();
  return peekVisit(s.trail, -1) !== null;
};
const whenTrailForward = () => {
  const s = useProjectStore.getState();
  return peekVisit(s.trail, 1) !== null;
};

/** Export acts on the live document and only makes sense for a native `.folio`
 *  (the format we project out of). */
const whenActiveFolio = () => {
  const s = useProjectStore.getState();
  const doc = s.liveDoc;
  return s.manifest !== null && doc != null && fileMode(doc.path) === 'rich';
};

/** The `.md`/import -> `.folio` upgrade acts on the live doc, and only when it's
 *  a convertible source (Markdown / HTML / plain text — not already a `.folio`). */
const whenActiveConvertible = () => {
  const s = useProjectStore.getState();
  const doc = s.liveDoc;
  return s.manifest !== null && doc != null && importKind(doc.path) !== null;
};

/** The Insert commands act on the block surface, so they're runnable only when
 *  it's mounted — i.e. a document is open in the rendered (not raw / not diff)
 *  view. The active-surface slot is non-null exactly then. */
const whenBlockSurface = () => getActiveBlockMenu() != null;

/** Undo/redo are palette entries gated on the block surface's history depth (the
 *  surface owns the ⌘Z chords; these reads mirror its enabled state). */
const whenCanUndo = () => getActiveBlockMenu()?.canUndo() ?? false;
const whenCanRedo = () => getActiveBlockMenu()?.canRedo() ?? false;

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
  // A handler upstream (e.g. the block surface's own keydown capture) may have
  // already consumed this chord and called preventDefault — respect that so a
  // surface-owned shortcut and a window-level binding never both fire on the
  // same keystroke (SKR-171).
  if (e.defaultPrevented) return false;
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
      // ⌘F is in-document find; project search moved to ⌘⇧F (below), the chord it
      // vacated for the find bar. Find opens on any editable document.
      chord: { code: 'KeyF', mod: true },
      display: '⌘F',
      scope: 'window',
      group: 'View',
      label: 'Find in document',
      commandId: 'edit.find',
      when: whenLiveDoc,
      run: () => useFindStore.getState().openFind()
    },
    {
      chord: { code: 'KeyF', mod: true, alt: true },
      display: '⌥⌘F',
      scope: 'window',
      group: 'View',
      label: 'Replace in document',
      commandId: 'edit.replace',
      when: whenLiveDoc,
      run: () => useFindStore.getState().openReplace()
    },
    {
      chord: { code: 'KeyF', mod: true, shift: true },
      display: '⌘⇧F',
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
      when: whenLiveDocDirty,
      run: async () => {
        try {
          await useProjectStore.getState().saveLiveDoc();
        } catch (err) {
          logProjectError('saveLiveDoc (binding)', err);
          notify.error("Couldn't save", err);
        }
      }
    },
    {
      // ⌘⇧T, mnemonically "today". Chosen over ⌘⇧N and ⌘⇧J because it is the
      // one that reads as the thing it does; ⌘⇧D is focus mode.
      chord: { code: 'KeyT', mod: true, shift: true },
      display: '⌘⇧T',
      scope: 'window',
      group: 'File',
      label: "Open today's note",
      commandId: 'daily.openToday',
      when: whenManifestOpen,
      run: () => {
        void useProjectStore
          .getState()
          .openDailyNote()
          .catch((err) => logProjectError('openDailyNote (binding)', err));
      }
    },
    {
      chord: { code: 'F2' },
      display: 'F2',
      scope: 'window',
      group: 'File',
      label: 'Rename file…',
      commandId: 'file.rename',
      when: whenLiveDocAndManifest,
      run: () => {
        const doc = useProjectStore.getState().liveDoc;
        if (doc) deps.openRename(doc.path);
      }
    },

    // ⌘⇧[ / ⌘⇧] — the chords tabs vacated (SKR-243): document history
    // back / forward, so the old prev/next-tab muscle memory transfers to
    // the trail with zero displacement. ⌘W is deliberately unbound — the
    // platform default (close window) takes over; there is nothing to
    // "close" in the working-set model.
    {
      chord: { code: 'BracketLeft', mod: true, shift: true },
      display: '⌘⇧[',
      scope: 'window',
      group: 'File',
      label: 'Previous document',
      commandId: 'history.back',
      when: whenTrailBack,
      run: () => void useProjectStore.getState().historyBack()
    },
    {
      chord: { code: 'BracketRight', mod: true, shift: true },
      display: '⌘⇧]',
      scope: 'window',
      group: 'File',
      label: 'Next document',
      commandId: 'history.forward',
      when: whenTrailForward,
      run: () => void useProjectStore.getState().historyForward()
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
    // The frontmatter panel's ⌘⇧F was reassigned to project search (it vacated ⌘F
    // for in-document find). The toggle stays reachable from the palette + View menu
    // via the 'view.toggleFrontmatter' command; it no longer carries a chord.
    {
      chord: { code: 'KeyB', mod: true, shift: true },
      display: '⌘⇧B',
      scope: 'window',
      group: 'View',
      label: 'Toggle backlinks panel',
      commandId: 'view.toggleBacklinks',
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleBacklinksPanel()
    },
    {
      chord: { code: 'KeyH', mod: true, shift: true },
      display: '⌘⇧H',
      scope: 'window',
      group: 'View',
      label: 'Toggle version history panel',
      commandId: 'view.toggleHistory',
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleHistoryPanel()
    },
    {
      chord: { code: 'KeyE', mod: true, shift: true },
      display: '⌘⇧E',
      scope: 'window',
      group: 'View',
      label: 'Cycle editor layout',
      commandId: 'view.toggleSource',
      when: whenLiveDoc,
      // Flush-then-switch: drain the outgoing surface's pending edits into the
      // canonical body, then cycle the Markdown layout (source -> split ->
      // preview). Both are synchronous store writes inside one keydown handler,
      // so React re-renders once and the incoming view mounts reading the
      // fully-flushed body — no edit loss. Markdown-only; rich tabs have no
      // layout to cycle.
      run: () => {
        flushActiveEditor();
        const s = useProjectStore.getState();
        const doc = s.liveDoc;
        if (!doc || doc.mode !== 'markdown') return;
        const order = ['raw', 'split', 'preview'] as const;
        const next = order[(order.indexOf(doc.layoutMode) + 1) % order.length]!;
        s.setLiveDocLayoutMode(doc.path, next);
      }
    },
    {
      chord: { code: 'KeyD', mod: true, shift: true },
      display: '⌘⇧D',
      scope: 'window',
      group: 'View',
      label: 'Focus mode',
      commandId: 'view.toggleFocusMode',
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleFocusMode()
    },
    {
      // Escape leaves focus mode — the universal way out, so the writer is never
      // stuck in stripped chrome hunting for the chord. Window-scope and gated on
      // the mode being on, so it is inert otherwise; a surface or menu that already
      // consumed the key called preventDefault, and dispatchKey honours that
      // (SKR-171) — dismissing the bubble never also drops out of the mode.
      chord: { code: 'Escape' },
      display: 'Esc',
      scope: 'window',
      group: 'View',
      label: 'Leave focus mode',
      when: whenFocusMode,
      run: () => useProjectStore.getState().setFocusMode(false)
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
      chord: { code: 'KeyZ', mod: true },
      display: '⌘Z',
      scope: 'surface',
      group: 'Edit',
      label: 'Undo',
      commandId: 'edit.undo'
    },
    {
      chord: { code: 'KeyZ', mod: true, shift: true },
      display: '⌘⇧Z',
      scope: 'surface',
      group: 'Edit',
      label: 'Redo',
      commandId: 'edit.redo'
    },
    // Table row/column INSERT chords. Removal and the rest of table structure live
    // in per-block hover chrome (the grammar's home for table editing), not the
    // palette — a collapsed caret is a lossy "which row/column" once focus leaves.
    // Catalogued here (run-less) so the cheat-sheet lists them; the surface handler
    // owns the dispatch.
    {
      chord: { code: 'ArrowUp', mod: true, alt: true },
      display: '⌥⌘↑',
      scope: 'surface',
      group: 'Edit',
      label: 'Table: insert row above'
    },
    {
      chord: { code: 'ArrowDown', mod: true, alt: true },
      display: '⌥⌘↓',
      scope: 'surface',
      group: 'Edit',
      label: 'Table: insert row below'
    },
    {
      chord: { code: 'ArrowLeft', mod: true, alt: true },
      display: '⌥⌘←',
      scope: 'surface',
      group: 'Edit',
      label: 'Table: insert column left'
    },
    {
      chord: { code: 'ArrowRight', mod: true, alt: true },
      display: '⌥⌘→',
      scope: 'surface',
      group: 'Edit',
      label: 'Table: insert column right'
    },
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
      id: 'daily.openToday',
      label: "Open today's note",
      group: 'File',
      shortcut: get('daily.openToday'),
      when: whenManifestOpen,
      run: () => {
        void useProjectStore
          .getState()
          .openDailyNote()
          .catch((err) => logProjectError('openDailyNote (command)', err));
      }
    },
    {
      id: 'edit.find',
      label: 'Find in document',
      group: 'View',
      shortcut: get('edit.find'),
      when: whenLiveDoc,
      run: () => useFindStore.getState().openFind()
    },
    {
      id: 'edit.replace',
      label: 'Replace in document',
      group: 'View',
      shortcut: get('edit.replace'),
      when: whenLiveDoc,
      run: () => useFindStore.getState().openReplace()
    },
    // ============ Edit ============
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      shortcut: get('edit.undo'),
      when: whenCanUndo,
      run: () => getActiveBlockMenu()?.undo()
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      shortcut: get('edit.redo'),
      when: whenCanRedo,
      run: () => getActiveBlockMenu()?.redo()
    },
    {
      id: 'edit.clearFormatting',
      label: 'Clear formatting',
      group: 'Edit',
      when: whenBlockSurface,
      run: () => getActiveBlockMenu()?.clearFormatting()
    },
    {
      id: 'file.save',
      label: 'Save',
      group: 'File',
      shortcut: get('file.save'),
      when: whenLiveDocDirty,
      run: async () => {
        try {
          await useProjectStore.getState().saveLiveDoc();
        } catch (err) {
          logProjectError('saveLiveDoc (palette)', err);
          notify.error("Couldn't save", err);
        }
      }
    },
    {
      id: 'file.rename',
      label: 'Rename file…',
      group: 'File',
      shortcut: get('file.rename'),
      when: whenLiveDocAndManifest,
      run: () => {
        const doc = useProjectStore.getState().liveDoc;
        if (doc) deps.openRename(doc.path);
      }
    },
    // One "Export as <format>" per registered format. Runnable only for a native
    // `.folio` document; acts on the active tab.
    ...EXPORT_FORMATS.map(
      (fmt): Command => ({
        id: `file.export.${fmt.id}`,
        label: `Export as ${fmt.label}`,
        group: 'File',
        when: whenActiveFolio,
        run: () => {
          const s = useProjectStore.getState();
          if (s.liveDoc) void s.exportDocument(s.liveDoc.path, fmt.id);
        }
      })
    ),
    {
      id: 'file.convertToFolio',
      label: 'Convert to Skrive document',
      group: 'File',
      when: whenActiveConvertible,
      run: () => {
        const s = useProjectStore.getState();
        if (s.liveDoc) void s.convertToFolio(s.liveDoc.path);
      }
    },

    {
      id: 'history.back',
      label: 'Previous document',
      group: 'File',
      shortcut: get('history.back'),
      when: whenTrailBack,
      run: () => void useProjectStore.getState().historyBack()
    },
    {
      id: 'history.forward',
      label: 'Next document',
      group: 'File',
      shortcut: get('history.forward'),
      when: whenTrailForward,
      run: () => void useProjectStore.getState().historyForward()
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
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleFrontmatterPanel()
    },
    {
      id: 'view.toggleBacklinks',
      label: 'Toggle backlinks panel',
      group: 'View',
      shortcut: get('view.toggleBacklinks'),
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleBacklinksPanel()
    },
    {
      id: 'view.toggleHistory',
      label: 'Toggle version history panel',
      group: 'View',
      shortcut: get('view.toggleHistory'),
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleHistoryPanel()
    },
    {
      id: 'view.toggleSource',
      label: 'Cycle editor layout',
      group: 'View',
      shortcut: get('view.toggleSource'),
      when: whenLiveDoc,
      run: () => {
        flushActiveEditor();
        const s = useProjectStore.getState();
        const doc = s.liveDoc;
        if (!doc || doc.mode !== 'markdown') return;
        const order = ['raw', 'split', 'preview'] as const;
        const next = order[(order.indexOf(doc.layoutMode) + 1) % order.length]!;
        s.setLiveDocLayoutMode(doc.path, next);
      }
    },
    {
      id: 'view.toggleFocusMode',
      label: 'Focus mode',
      group: 'View',
      shortcut: get('view.toggleFocusMode'),
      when: whenLiveDoc,
      run: () => useProjectStore.getState().toggleFocusMode()
    },
    // Per-document measure override (mirrors the View-menu radio group;
    // palette-only, no chords — the View group's are spoken for).
    ...(
      [
        ['Default', null],
        ['Narrow', 'narrow'],
        ['Normal', 'normal'],
        ['Wide', 'wide'],
        ['Full', 'full']
      ] as const
    ).map<Command>(([label, value]) => ({
      id: `view.docMeasure.${value ?? 'default'}`,
      label: `Document measure: ${label}`,
      group: 'View',
      when: whenDocMeasureHome,
      run: () => useProjectStore.getState().setLiveDocLineMeasure(value)
    })),
    {
      id: 'view.measureWider',
      label: 'Measure: wider',
      group: 'View',
      when: whenLiveDoc,
      run: () => nudgeMeasure(MEASURE_NUDGE_CH)
    },
    {
      id: 'view.measureNarrower',
      label: 'Measure: narrower',
      group: 'View',
      when: whenLiveDoc,
      run: () => nudgeMeasure(-MEASURE_NUDGE_CH)
    },
    {
      id: 'view.toggleMeasureRule',
      label: 'Toggle measure rule',
      group: 'View',
      when: whenLiveDoc,
      run: () => {
        const s = usePreferencesStore.getState();
        s.setShowMeasureRule(!s.showMeasureRule);
      }
    },

    // ============ Insert (block surface affordances) ============
    // Generated from INSERT_CATALOG so the palette Insert group, the toolbar
    // Insert dropdown, and the slash menu never drift (SKR-243 grammar §3).
    // Gated to the mounted block surface and dispatched through its
    // MenuController; block-type specs map 1:1 to its commands (dispatchInsert).
    // Each entry's `when` is evaluated against the live selection so it gates
    // identically to the other two renderers.
    ...INSERT_CATALOG.map<Command>((entry) => ({
      id: `insert.${entry.id}`,
      label: entry.title,
      group: 'Insert',
      when: () => {
        const menu = getActiveBlockMenu();
        if (!menu) return false;
        return entry.when
          ? entry.when({ inTable: menu.getSnapshot().selection.inTable })
          : true;
      },
      run: () => {
        const menu = getActiveBlockMenu();
        if (menu) dispatchInsert(menu, entry.spec);
      }
    })),
    // Link is a bubble-owned formatting affordance (its toolbar button retired,
    // grammar resolved call 1), not a catalog entry — but it keeps a palette
    // command as a discoverable path, opening the same link editor.
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
