// Invariants for the central command + binding registry. These exist
// because the audit (Phase 13) found a binding that was advertised in
// the palette but never bound (⌘⇧W → close project). The whole point
// of the registry is making that class of drift impossible — tests
// here pin the invariants.

import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  chordMatches,
  matchWindowBinding,
  type CommandDeps
} from '../src/lib/commands/registry';

const noop = () => {};
const STUB_DEPS: CommandDeps = {
  toggleFileSwitcher: noop,
  toggleCommandPalette: noop,
  toggleSearch: noop,
  toggleCheatSheet: noop,
  openRename: noop,
  openNewProject: noop
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
}): KeyboardEvent {
  return {
    code: opts.code,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    preventDefault: () => {}
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
});
