// Markdown-aware skip layer for the OS spellchecker.
//
// We let the webview's native spellchecker run across the editor surface
// and then *exclude* the markdown regions that don't make sense to
// spellcheck. The mechanism is per-region `spellcheck="false"` HTML
// attributes pushed via `Decoration.mark`, which the browser honors
// inside a contenteditable.
//
// Regions handled:
//
//   - Inline code spans (`` `foo` ``)        — see `code.ts`, modified to
//                                               add the attribute on its
//                                               existing inner mark.
//   - Fenced code blocks (``` ``` ```)       — `FencedCode` node.
//   - Indented code blocks (4-space)        — `CodeBlock` node.
//   - Embedded HTML blocks                   — `HTMLBlock` node.
//   - URL targets in links and images        — `URL` node.
//   - Heading marks (`#`, `##`, ...)         — `HeaderMark` node.
//   - Leading YAML frontmatter block         — separate ViewPlugin below.
//
// Cursor-line behavior: spellcheck disable is *not* cursor-aware. The
// point of the skip is structural — these characters aren't prose at
// any time, so the OS should never check them.

import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import type { HandlerMap, NodeHandler } from './shared';

const SPELLCHECK_OFF_SPEC = { attributes: { spellcheck: 'false' } };

const skipNode: NodeHandler = (node, ctx) => {
  if (node.to <= node.from) return;
  ctx.decorations.push(
    Decoration.mark(SPELLCHECK_OFF_SPEC).range(node.from, node.to)
  );
};

export const spellcheckHandlers: HandlerMap = {
  FencedCode: skipNode,
  CodeBlock: skipNode,
  HTMLBlock: skipNode,
  URL: skipNode,
  HeaderMark: skipNode
};

// ============================ Frontmatter ============================
//
// The Lezer markdown grammar doesn't produce a top-level node for the
// `---...---` frontmatter block. The editor surface shows the unstripped
// on-disk text, so the YAML still gets shown to the spellchecker unless
// we explicitly tell it not to.

function findLeadingFrontmatterEnd(view: EditorView): number | null {
  const doc = view.state.doc;
  const total = doc.length;
  if (total < 4) return null;

  const head = doc.sliceString(0, Math.min(5, total));
  let prefixLen: number;
  if (head.startsWith('---\n')) {
    prefixLen = 4;
  } else if (head.startsWith('---\r\n')) {
    prefixLen = 5;
  } else {
    return null;
  }

  let line = doc.lineAt(prefixLen);
  while (true) {
    const text = doc.sliceString(line.from, line.to);
    const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text;
    if (trimmed === '---' || trimmed === '...') {
      return Math.min(line.to + 1, total);
    }
    if (line.number >= doc.lines) return null;
    line = doc.line(line.number + 1);
  }
}

export const spellcheckFrontmatterPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const end = findLeadingFrontmatterEnd(view);
      if (end === null || end <= 0) return Decoration.none;
      return Decoration.set([
        Decoration.mark(SPELLCHECK_OFF_SPEC).range(0, end)
      ]);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

// ============================ Personal dictionary ============================
//
// Words on the personal dictionary list get `spellcheck="false"`
// decorations on every occurrence. Updates flow in via a StateEffect
// dispatched from outside (the React Editor wrapper will dispatch
// whenever preferences change — wired in Phase 9).

export const setPersonalDictionary = StateEffect.define<string[]>();

type PersonalDictState = {
  dictionary: string[];
  decorations: DecorationSet;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPersonalDictDecorations(
  state: EditorState,
  dictionary: string[]
): DecorationSet {
  if (dictionary.length === 0) return Decoration.none;
  const escaped = dictionary.map(escapeRegex).filter((s) => s.length > 0);
  if (escaped.length === 0) return Decoration.none;
  const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');

  const builder: Range<Decoration>[] = [];
  const text = state.doc.toString();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    builder.push(Decoration.mark(SPELLCHECK_OFF_SPEC).range(from, to));
    if (to === from) pattern.lastIndex += 1;
  }
  return Decoration.set(builder, true);
}

export const personalDictionaryField = StateField.define<PersonalDictState>({
  create() {
    return { dictionary: [], decorations: Decoration.none };
  },
  update(value, tr) {
    let dictionary = value.dictionary;
    let dictionaryChanged = false;
    for (const e of tr.effects) {
      if (e.is(setPersonalDictionary)) {
        dictionary = e.value;
        dictionaryChanged = true;
      }
    }
    if (!dictionaryChanged && !tr.docChanged) {
      return value;
    }
    const decorations = buildPersonalDictDecorations(tr.state, dictionary);
    return { dictionary, decorations };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations)
});
