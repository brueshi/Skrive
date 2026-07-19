// The Insert catalog (SKR-243, chrome-affordance-grammar §3): one static registry
// of insertable blocks that three surfaces render from — the slash menu, the
// toolbar Insert dropdown, and the palette Insert group. Before this, those were
// three hand-maintained lists that drifted (BlockSlashMenu ITEMS, registry.ts
// insert commands, the toolbar's standalone buttons). Now there is one array;
// slash/Insert parity is a rule the grammar states — same entries, same `when`,
// same matcher.
//
// Scope, deliberately: only currently-wired block types appear. Groups map to the
// grammar's taxonomy Text · Lists · Blocks; the doc's Inline (footnote, wiki link,
// emoji) and Media (image, chart) groups populate as those features land — no dead
// rows now. Link is NOT here: it is a formatting affordance the bubble owns (the
// toolbar button was retired, resolved call 1), and the slash menu cannot apply a
// link, so a Link row would break the both-or-neither parity rule. When SKR-110's
// affordance registries arrive, they replace this array, not the surfaces.

import type { ComponentType } from 'react';
import type { BlockTypeSpec } from '../../../lib/blocksurface';
import type { MenuController } from './controller';
import {
  IconParagraph,
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconBulletList,
  IconOrderedList,
  IconQuote,
  IconCodeBlock,
  IconTable,
  IconDivider,
  IconFootnote
} from './toolbar-icons';

type IconC = ComponentType<{ size?: number; className?: string }>;

/** The near-term slice of the grammar's group taxonomy. A hairline separates
 *  consecutive groups in every renderer (no text headers — the calm-menu
 *  language). `inline` / `media` join when their features ship. */
export type InsertGroup = 'text' | 'list' | 'block' | 'inline';

export const INSERT_GROUP_ORDER: InsertGroup[] = ['text', 'list', 'block', 'inline'];

/** The selection facts a `when` predicate reads. Every renderer passes what it
 *  has (the slash menu and dropdown from the surface's SelectionInfo, the palette
 *  from the controller snapshot) so availability is decided identically. */
export type InsertContext = { inTable: boolean };

export type InsertEntry = {
  /** Stable id; also the palette command suffix (`insert.<id>`). */
  id: string;
  title: string;
  /** Space-joined synonyms for the matcher, lowercase. */
  keywords: string;
  Icon: IconC;
  group: InsertGroup;
  /** The canonical action. The slash menu hands it to applySlashCommand; the
   *  dropdown and palette route it through dispatchInsert. */
  spec: BlockTypeSpec;
  /** Right-hint: the Markdown input rule where one is ACTUALLY wired (preferred),
   *  rendered literally. Only real rules — an aspirational hint would lie. */
  inputRuleHint?: string;
  /** Right-hint fallback: a bound keyboard shortcut, rendered via platformShortcut.
   *  Shown only when there is no input rule. */
  shortcutHint?: string;
  /** Availability, applied identically by every renderer. Absent = always. */
  when?: (ctx: InsertContext) => boolean;
};

// Table cells are coordinate-addressed, not leaf blocks, so a block conversion /
// insert has nothing to act on there (SKR-219) — hidden rather than shown dead.
const notInTable = (ctx: InsertContext) => !ctx.inTable;

export const INSERT_CATALOG: InsertEntry[] = [
  // Text
  { id: 'text', title: 'Text', keywords: 'text paragraph body plain', Icon: IconParagraph, group: 'text', spec: { kind: 'paragraph' } },
  { id: 'heading-1', title: 'Heading 1', keywords: 'h1 heading title', Icon: IconHeading1, group: 'text', spec: { kind: 'heading', level: 1 }, inputRuleHint: '# ' },
  { id: 'heading-2', title: 'Heading 2', keywords: 'h2 heading subtitle', Icon: IconHeading2, group: 'text', spec: { kind: 'heading', level: 2 }, inputRuleHint: '## ' },
  { id: 'heading-3', title: 'Heading 3', keywords: 'h3 heading', Icon: IconHeading3, group: 'text', spec: { kind: 'heading', level: 3 }, inputRuleHint: '### ' },
  // Lists — the input rule is the fast path (grammar §3: prefer the rule where one
  // exists); ⌘⇧8 / ⌘⇧7 are the bound fallback (surface keymap), shown by no renderer
  // that already carries the rule.
  { id: 'bullet-list', title: 'Bullet list', keywords: 'bullet list unordered ul', Icon: IconBulletList, group: 'list', spec: { kind: 'bullet_list' }, inputRuleHint: '- ', shortcutHint: '⌘⇧8', when: notInTable },
  { id: 'numbered-list', title: 'Numbered list', keywords: 'numbered ordered list ol', Icon: IconOrderedList, group: 'list', spec: { kind: 'ordered_list' }, inputRuleHint: '1. ', shortcutHint: '⌘⇧7', when: notInTable },
  // Blocks — no input rule is wired for quote / code / table / divider, so none is
  // advertised.
  { id: 'quote', title: 'Quote', keywords: 'quote blockquote', Icon: IconQuote, group: 'block', spec: { kind: 'blockquote' }, when: notInTable },
  { id: 'code', title: 'Code', keywords: 'code monospace pre fenced', Icon: IconCodeBlock, group: 'block', spec: { kind: 'code' }, when: notInTable },
  { id: 'table', title: 'Table', keywords: 'table grid rows columns', Icon: IconTable, group: 'block', spec: { kind: 'table' }, when: notInTable },
  { id: 'divider', title: 'Divider', keywords: 'divider rule separator hr line', Icon: IconDivider, group: 'block', spec: { kind: 'divider' }, when: notInTable },
  // Inline — the first entry in the grammar's Inline group. A footnote is an
  // inline-atom insert (a reference + a seeded definition), not a block conversion;
  // it lands at the caret. Table cells have no inline-atom insert path, so hide it
  // there (like the block entries).
  { id: 'footnote', title: 'Footnote', keywords: 'footnote note reference citation aside', Icon: IconFootnote, group: 'inline', spec: { kind: 'footnote' }, when: notInTable }
];

/** Subsequence match: every char of `q` appears in `haystack` in order. The
 *  substring→fuzzy upgrade the grammar calls for — order-preserving (no scoring),
 *  so the grouped presentation is untouched and "nl" still finds "Numbered list".
 *  `q` and `haystack` are expected pre-lowercased by the caller. */
export function fuzzyMatch(q: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < q.length; j++) {
    if (haystack[j] === q[i]) i++;
  }
  return i === q.length;
}

/** The one matcher shared by the slash menu and the Insert dropdown (grammar §3:
 *  parity means the matcher is shared too). Filters by `when` first, then by a
 *  fuzzy match over title + keywords; catalog order is preserved so groups stay
 *  intact. An empty query returns everything available. */
export function filterCatalog(query: string, ctx: InsertContext): InsertEntry[] {
  const available = INSERT_CATALOG.filter((e) => (e.when ? e.when(ctx) : true));
  const q = query.trim().toLowerCase();
  if (!q) return available;
  return available.filter(
    (e) => fuzzyMatch(q, e.title.toLowerCase()) || fuzzyMatch(q, e.keywords)
  );
}

/** The right-hint string for a row: the literal input rule where one exists, else
 *  the shortcut (which the caller runs through platformShortcut). Returns the kind
 *  so the caller knows whether to symbol-map it. */
export function catalogHint(entry: InsertEntry): { text: string; kind: 'rule' | 'shortcut' } | null {
  if (entry.inputRuleHint) return { text: entry.inputRuleHint, kind: 'rule' };
  if (entry.shortcutHint) return { text: entry.shortcutHint, kind: 'shortcut' };
  return null;
}

/** Apply a catalog entry through the editor-agnostic controller — the shared
 *  dispatch for the Insert dropdown and the palette Insert group. (The slash menu
 *  dispatches via surface.applySlashCommand instead, which also consumes the typed
 *  "/query" run before applying; both land on the same setBlockType sink.) Block-
 *  type specs map 1:1 to the controller's command methods. */
export function dispatchInsert(controller: MenuController, spec: BlockTypeSpec): void {
  switch (spec.kind) {
    case 'paragraph':
      return controller.setParagraph();
    case 'heading':
      return controller.setHeading(spec.level);
    case 'bullet_list':
      return controller.toggleBulletList();
    case 'ordered_list':
      return controller.toggleOrderedList();
    case 'blockquote':
      return controller.toggleBlockquote();
    case 'code':
      return controller.setCodeBlock();
    case 'table':
      return controller.insertTable();
    case 'divider':
      return controller.insertDivider();
    case 'footnote':
      return controller.insertFootnote();
  }
}
