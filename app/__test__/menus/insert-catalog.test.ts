// Invariants for the Insert catalog (SKR-243) — the single registry the slash
// menu, the toolbar Insert dropdown, and the palette Insert group all render
// from. These pin the parity contract the grammar states (same entries, same
// `when`, same matcher) and the spec→controller dispatch, so the three surfaces
// can never drift apart. Chrome rendering is verified in the real shell; this
// guards the pure core.

import { describe, expect, it } from 'vitest';
import {
  INSERT_CATALOG,
  catalogHint,
  dispatchInsert,
  filterCatalog
} from '../../src/components/editor/menus/insert-catalog';
import type { MenuController } from '../../src/components/editor/menus/controller';
import { buildRegistry, type CommandDeps } from '../../src/lib/commands/registry';

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

/** A MenuController that records only the block commands dispatchInsert uses. */
function recordingController(): { controller: MenuController; calls: string[] } {
  const calls: string[] = [];
  const controller = {
    setParagraph: () => calls.push('paragraph'),
    setHeading: (level: number) => calls.push(`heading:${level}`),
    setCodeBlock: () => calls.push('code'),
    toggleBulletList: () => calls.push('bullet'),
    toggleOrderedList: () => calls.push('ordered'),
    toggleBlockquote: () => calls.push('quote'),
    insertDivider: () => calls.push('divider'),
    insertTable: () => calls.push('table'),
    insertFootnote: () => calls.push('footnote')
  } as unknown as MenuController;
  return { controller, calls };
}

describe('filterCatalog', () => {
  it('returns every entry for an empty query outside a table', () => {
    expect(filterCatalog('', { inTable: false })).toHaveLength(INSERT_CATALOG.length);
  });

  it('hides block conversions/inserts inside a table (only Text + headings survive)', () => {
    const inTable = filterCatalog('', { inTable: true }).map((e) => e.id);
    expect(inTable).toEqual(['text', 'heading-1', 'heading-2', 'heading-3']);
  });

  it('fuzzily matches a subsequence of the title', () => {
    const ids = filterCatalog('nl', { inTable: false }).map((e) => e.id);
    expect(ids).toContain('numbered-list');
  });

  it('matches keyword synonyms, not just the title', () => {
    // "ul" is a keyword on the bullet list, not in its title.
    const ids = filterCatalog('ul', { inTable: false }).map((e) => e.id);
    expect(ids).toContain('bullet-list');
  });

  it('narrows to nothing when no entry matches', () => {
    expect(filterCatalog('zzzz', { inTable: false })).toHaveLength(0);
  });
});

describe('catalogHint', () => {
  it('prefers the input rule over a bound shortcut', () => {
    const bullet = INSERT_CATALOG.find((e) => e.id === 'bullet-list')!;
    expect(catalogHint(bullet)).toEqual({ text: '- ', kind: 'rule' });
  });

  it('falls back to the shortcut when there is no input rule', () => {
    // Every catalog entry with a shortcut today also has an input rule, so
    // synthesize the fallback case to pin the precedence rule itself.
    expect(catalogHint({ shortcutHint: '⌘⇧8' } as never)).toEqual({
      text: '⌘⇧8',
      kind: 'shortcut'
    });
  });

  it('returns null when an entry advertises neither', () => {
    const quote = INSERT_CATALOG.find((e) => e.id === 'quote')!;
    expect(catalogHint(quote)).toBeNull();
  });
});

describe('dispatchInsert', () => {
  it('routes every catalog spec to a controller command (no missing case)', () => {
    for (const entry of INSERT_CATALOG) {
      const { controller, calls } = recordingController();
      dispatchInsert(controller, entry.spec);
      expect(calls, `${entry.id} dispatched nothing`).toHaveLength(1);
    }
  });

  it('maps each block-type kind to the right command', () => {
    const { controller, calls } = recordingController();
    dispatchInsert(controller, { kind: 'heading', level: 2 });
    dispatchInsert(controller, { kind: 'bullet_list' });
    dispatchInsert(controller, { kind: 'ordered_list' });
    dispatchInsert(controller, { kind: 'blockquote' });
    dispatchInsert(controller, { kind: 'code' });
    dispatchInsert(controller, { kind: 'table' });
    dispatchInsert(controller, { kind: 'divider' });
    dispatchInsert(controller, { kind: 'paragraph' });
    expect(calls).toEqual([
      'heading:2',
      'bullet',
      'ordered',
      'quote',
      'code',
      'table',
      'divider',
      'paragraph'
    ]);
  });
});

describe('palette Insert group parity', () => {
  const insertCommands = buildRegistry(STUB_DEPS).commands.filter(
    (c) => c.group === 'Insert'
  );

  it('generates one command per catalog entry, plus the bubble-owned link', () => {
    const ids = new Set(insertCommands.map((c) => c.id));
    for (const entry of INSERT_CATALOG) {
      expect(ids, `missing palette command for ${entry.id}`).toContain(
        `insert.${entry.id}`
      );
    }
    expect(ids).toContain('insert.link');
    expect(insertCommands).toHaveLength(INSERT_CATALOG.length + 1);
  });
});
