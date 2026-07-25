// @vitest-environment jsdom
//
// Invariants for the central command + binding registry. These exist
// because the audit (Phase 13) found a binding that was advertised in
// the palette but never bound (⌘⇧W → close project). The whole point
// of the registry is making that class of drift impossible — tests
// here pin the invariants.
//
// jsdom, because one predicate reads the live DOM: focus mode's Escape exit
// stands down while a dismissable layer is open.

import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  chordMatches,
  dispatchKey,
  matchWindowBinding,
  type CommandDeps
} from '../src/lib/commands/registry';
import { useProjectStore, type LiveDoc } from '../src/stores/project';
import { usePreferencesStore } from '../src/stores/preferences';

const noop = () => {};
const STUB_DEPS: CommandDeps = {
  toggleFileSwitcher: noop,
  toggleCommandPalette: noop,
  toggleSearch: noop,
  toggleCheatSheet: noop,
  openRename: noop,
  openNewProject: noop,
  openBugReport: noop,
  openFeedback: noop
};

function chordKey(c: {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}): string {
  return [
    c.mod ? 'M' : '_',
    c.shift ? 'S' : '_',
    c.alt ? 'A' : '_',
    c.code
  ].join(':');
}

function fakeEvent(opts: {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  defaultPrevented?: boolean;
}): KeyboardEvent {
  let prevented = opts.defaultPrevented ?? false;
  return {
    code: opts.code,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    }
  } as unknown as KeyboardEvent;
}

describe('command registry', () => {
  const { commands, bindings } = buildRegistry(STUB_DEPS);

  it('every commandId on a binding resolves to a real command', () => {
    const ids = new Set(commands.map((c) => c.id));
    for (const b of bindings) {
      if (!b.commandId) continue;
      expect(ids, `binding "${b.label}" → unknown commandId ${b.commandId}`)
        .toContain(b.commandId);
    }
  });

  it('no two window-scope bindings match the same chord', () => {
    const seen = new Map<string, string>();
    for (const b of bindings) {
      if (b.scope !== 'window') continue;
      const key = chordKey(b.chord);
      const prev = seen.get(key);
      if (prev) {
        throw new Error(
          `chord ${b.display} bound twice — "${prev}" and "${b.label}"`
        );
      }
      seen.set(key, b.label);
    }
  });

  it("every command with a `shortcut` matches its binding's display", () => {
    const displayFor = new Map(
      bindings.filter((b) => b.commandId).map((b) => [b.commandId!, b.display])
    );
    for (const c of commands) {
      if (!c.shortcut) continue;
      expect(c.shortcut, `command ${c.id} shortcut drift`).toBe(
        displayFor.get(c.id)
      );
    }
  });

  it('the orphaned ⌘⇧W close-project binding from pre-13a is now wired', () => {
    const closeProject = bindings.find((b) => b.commandId === 'project.close');
    expect(closeProject).toBeDefined();
    expect(closeProject?.scope).toBe('window');
    expect(closeProject?.display).toBe('⌘⇧W');
    expect(closeProject?.run).toBeTypeOf('function');
  });
});

describe('source toggle (⌘⇧E)', () => {
  const { commands, bindings } = buildRegistry(STUB_DEPS);
  const binding = bindings.find((b) => b.commandId === 'view.toggleSource');
  const command = commands.find((c) => c.id === 'view.toggleSource');

  it('binds ⌘⇧E in the View group, twinned with a palette command', () => {
    expect(binding).toBeDefined();
    expect(binding?.scope).toBe('window');
    expect(binding?.group).toBe('View');
    expect(binding?.display).toBe('⌘⇧E');
    expect(binding?.run).toBeTypeOf('function');
    expect(command).toBeDefined();
    expect(command?.shortcut).toBe('⌘⇧E');
  });

  it('is runnable only when a document is live', () => {
    useProjectStore.setState({
      liveDoc: { path: 'a.md' } as unknown as LiveDoc
    });
    expect(binding?.when?.()).toBe(true);

    // No live doc → nothing to view as source.
    useProjectStore.setState({ liveDoc: null });
    expect(binding?.when?.()).toBe(false);
  });

  it("cycles the live markdown doc's layout (raw -> split -> preview) when run", () => {
    const doc = {
      path: 'a.md',
      mode: 'markdown',
      layoutMode: 'split'
    } as unknown as LiveDoc;
    useProjectStore.setState({ liveDoc: doc });
    binding?.run?.();
    expect(useProjectStore.getState().liveDoc?.layoutMode).toBe('preview');
    binding?.run?.();
    expect(useProjectStore.getState().liveDoc?.layoutMode).toBe('raw');
    binding?.run?.();
    expect(useProjectStore.getState().liveDoc?.layoutMode).toBe('split');
  });

  it('is a no-op on a rich (.folio) doc', () => {
    const doc = {
      path: 'a.folio',
      mode: 'rich',
      layoutMode: 'split'
    } as unknown as LiveDoc;
    useProjectStore.setState({ liveDoc: doc });
    binding?.run?.();
    expect(useProjectStore.getState().liveDoc?.layoutMode).toBe('split');
  });
});

describe('chordMatches', () => {
  it('matches mod-only chord with metaKey or ctrlKey', () => {
    const chord = { code: 'KeyP', mod: true };
    expect(chordMatches(fakeEvent({ code: 'KeyP', meta: true }), chord)).toBe(
      true
    );
    expect(chordMatches(fakeEvent({ code: 'KeyP', ctrl: true }), chord)).toBe(
      true
    );
    expect(chordMatches(fakeEvent({ code: 'KeyP' }), chord)).toBe(false);
  });

  it('discriminates ⌘P from ⌘⇧P by shift', () => {
    const plain = { code: 'KeyP', mod: true };
    const shifted = { code: 'KeyP', mod: true, shift: true };
    const ev = fakeEvent({ code: 'KeyP', meta: true, shift: true });
    expect(chordMatches(ev, plain)).toBe(false);
    expect(chordMatches(ev, shifted)).toBe(true);
  });

  it('rejects extra modifiers not in the chord', () => {
    const chord = { code: 'KeyB', mod: true };
    const ev = fakeEvent({ code: 'KeyB', meta: true, alt: true });
    expect(chordMatches(ev, chord)).toBe(false);
  });
});

describe('matchWindowBinding', () => {
  const { bindings } = buildRegistry(STUB_DEPS);

  it('finds ⌘⇧W → project.close', () => {
    const ev = fakeEvent({ code: 'KeyW', meta: true, shift: true });
    const b = matchWindowBinding(ev, bindings);
    expect(b?.commandId).toBe('project.close');
  });

  it('finds ⌘P → file.openSwitcher (not the surface n/p nav entries)', () => {
    const ev = fakeEvent({ code: 'KeyP', meta: true });
    const b = matchWindowBinding(ev, bindings);
    expect(b?.commandId).toBe('file.openSwitcher');
  });

  it('returns null for an unbound chord', () => {
    const ev = fakeEvent({ code: 'KeyZ', meta: true, alt: true });
    expect(matchWindowBinding(ev, bindings)).toBeNull();
  });

  // SKR-243: tabs retired. ⌘W reverts to the platform default (close
  // window) and the freed cycling chords become document history.
  it('⌘W is unbound (platform close-window takes over)', () => {
    const ev = fakeEvent({ code: 'KeyW', meta: true });
    expect(matchWindowBinding(ev, bindings)).toBeNull();
  });

  it('⌘⇧[ / ⌘⇧] walk document history', () => {
    const back = matchWindowBinding(
      fakeEvent({ code: 'BracketLeft', meta: true, shift: true }),
      bindings
    );
    const fwd = matchWindowBinding(
      fakeEvent({ code: 'BracketRight', meta: true, shift: true }),
      bindings
    );
    expect(back?.commandId).toBe('history.back');
    expect(fwd?.commandId).toBe('history.forward');
  });
});

// SKR-171: the surface's own mark chord (⌘B) and the app-level ⌘⇧B binding
// share a key, disambiguated by Shift on the surface side — but a handler
// upstream of the window listener (the block surface's keydown capture) can
// still consume a chord and call preventDefault before it reaches here. The
// dispatcher must defer to that instead of double-firing.
describe('dispatchKey defers to an upstream preventDefault', () => {
  const { bindings } = buildRegistry(STUB_DEPS);

  it('skips a chord that arrives already defaultPrevented', () => {
    useProjectStore.setState({
      liveDoc: { path: 'a.md' } as unknown as LiveDoc
    });
    const ev = fakeEvent({ code: 'KeyB', meta: true, shift: true, defaultPrevented: true });
    expect(dispatchKey(ev, bindings)).toBe(false);
  });

  it('still dispatches a matching chord that was not consumed upstream', () => {
    useProjectStore.setState({
      liveDoc: { path: 'a.md' } as unknown as LiveDoc,
      backlinksPanelOpen: false
    });
    const ev = fakeEvent({ code: 'KeyB', meta: true, shift: true });
    expect(dispatchKey(ev, bindings)).toBe(true);
    expect(useProjectStore.getState().backlinksPanelOpen).toBe(true);
  });
});

// Palette-only measure nudges: entering Custom from a preset seeds at that
// preset's ch so the first step feels continuous; Full only narrows (it is
// already uncapped); everything clamps to the stepper range.
describe('measure nudge commands', () => {
  const { commands } = buildRegistry(STUB_DEPS);
  const wider = commands.find((c) => c.id === 'view.measureWider');
  const narrower = commands.find((c) => c.id === 'view.measureNarrower');

  it('enters custom from a preset, seeded at the preset ch', () => {
    usePreferencesStore.setState({
      lineMeasure: 'normal',
      lineMeasureCustomCh: 70
    });
    wider?.run();
    expect(usePreferencesStore.getState().lineMeasure).toBe('custom');
    expect(usePreferencesStore.getState().lineMeasureCustomCh).toBe(75);
  });

  it('steps an active custom value and clamps at the floor', () => {
    usePreferencesStore.setState({
      lineMeasure: 'custom',
      lineMeasureCustomCh: 42
    });
    narrower?.run();
    expect(usePreferencesStore.getState().lineMeasureCustomCh).toBe(40);
  });

  it('wider from full no-ops; narrower re-enters at the ceiling', () => {
    usePreferencesStore.setState({ lineMeasure: 'full' });
    wider?.run();
    expect(usePreferencesStore.getState().lineMeasure).toBe('full');
    narrower?.run();
    expect(usePreferencesStore.getState().lineMeasure).toBe('custom');
    expect(usePreferencesStore.getState().lineMeasureCustomCh).toBe(120);
  });
});

// Focus mode: a mode, so the grammar puts it on a chord + a palette command + a
// View-menu checkbox and nowhere near the toolbar. Escape is its way out, and
// that entry has to stay inert unless the mode is actually on — otherwise every
// Escape in the app would drop the writer out of nothing.
describe('focus mode (⌘⇧D)', () => {
  const { commands, bindings } = buildRegistry(STUB_DEPS);
  const binding = bindings.find((b) => b.commandId === 'view.toggleFocusMode');
  const command = commands.find((c) => c.id === 'view.toggleFocusMode');
  const escape = bindings.find(
    (b) => b.scope === 'window' && b.chord.code === 'Escape'
  );

  it('binds ⌘⇧D in the View group, twinned with a palette command', () => {
    expect(binding).toBeDefined();
    expect(binding?.scope).toBe('window');
    expect(binding?.group).toBe('View');
    expect(binding?.display).toBe('⌘⇧D');
    expect(binding?.run).toBeTypeOf('function');
    expect(command?.shortcut).toBe('⌘⇧D');
  });

  it('toggles the mode when run', () => {
    useProjectStore.setState({
      liveDoc: { path: 'a.folio' } as unknown as LiveDoc,
      focusMode: false,
      sidebarVisibleBeforeFocus: null,
      sidebarVisible: true
    });
    binding?.run?.();
    expect(useProjectStore.getState().focusMode).toBe(true);
    command?.run();
    expect(useProjectStore.getState().focusMode).toBe(false);
  });

  it('Escape only exits while the mode is on', () => {
    useProjectStore.setState({ focusMode: false });
    expect(escape?.when?.()).toBe(false);
    useProjectStore.setState({ focusMode: true });
    expect(escape?.when?.()).toBe(true);
  });

  it('Escape stands down while a dialog or menu owns the key', () => {
    useProjectStore.setState({ focusMode: true });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    // Radix dismisses on Escape without preventDefault, so the dispatcher's
    // defaultPrevented guard can't catch this one — the predicate has to.
    expect(escape?.when?.()).toBe(false);
    dialog.remove();
    expect(escape?.when?.()).toBe(true);
    useProjectStore.setState({ focusMode: false });
  });
});
