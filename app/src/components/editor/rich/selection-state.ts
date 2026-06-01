// Live UI state for the Rich surface's affordances (toolbar, selection bubble,
// link editor, slash menu), and the ProseMirror plugin that feeds it.
//
// The hard constraint: the Rich surface is uncontrolled — "PM owns its
// EditorState; React never sees a per-keystroke update" (RichEditor.tsx). A
// toolbar with live active states wants to know about selection changes, which
// happen about as often as keystrokes. So the plugin extracts only a *tiny*
// summary, pushes it to this store coalesced to one update per animation frame,
// and the store drops no-op pushes (shallow value-equality). Only the affordance
// components subscribe; the editor view never re-renders. The old lag came from
// routing the whole-doc serialize + save pipeline through React per keystroke —
// not from a small setState — so this stays well clear of that law's intent.

import { create } from 'zustand';
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  readSelectionSummary,
  summaryEqual,
  EMPTY_SELECTION_SUMMARY,
  type RichSelectionSummary
} from '../../../lib/projection/commands';

type LinkEditorState = {
  open: boolean;
  /** Prefill — the existing href when editing a link, '' when creating one. */
  href: string;
  /** True when a link already covers the target (so the editor offers Remove). */
  editing: boolean;
};

type SlashState = {
  open: boolean;
  /** Text typed after the `/` trigger, used to filter the menu. */
  query: string;
  /** Doc position of the `/` so a commit can replace the whole `/query` range. */
  from: number;
  /** Highlighted item in the filtered menu, driven by Arrow keys in the editor. */
  index: number;
};

type RichUiStore = {
  /** Current selection summary, pushed by selectionStatePlugin. */
  selection: RichSelectionSummary;
  /** Selection endpoints, so the bubble can place itself via view.coordsAtPos. */
  selFrom: number;
  selTo: number;
  /** Bumped whenever the view geometry the bubble depends on may have shifted
   *  (selection, doc) so the bubble recomputes coordinates. */
  geometry: number;
  setSelection(summary: RichSelectionSummary, from: number, to: number): void;
  resetSelection(): void;

  linkEditor: LinkEditorState;
  openLinkEditor(href: string, editing: boolean): void;
  closeLinkEditor(): void;

  slash: SlashState;
  setSlash(query: string, from: number): void;
  setSlashIndex(index: number): void;
  closeSlash(): void;
};

const CLOSED_LINK: LinkEditorState = { open: false, href: '', editing: false };
const CLOSED_SLASH: SlashState = { open: false, query: '', from: -1, index: 0 };

export const useRichUiStore = create<RichUiStore>((set, get) => ({
  selection: EMPTY_SELECTION_SUMMARY,
  selFrom: 0,
  selTo: 0,
  geometry: 0,
  setSelection(summary, from, to) {
    const cur = get();
    const sameSummary = summaryEqual(cur.selection, summary);
    if (sameSummary && from === cur.selFrom && to === cur.selTo) {
      return; // no-op push: skip the re-render entirely
    }
    set({
      // Preserve the previous object identity when the summary is unchanged, so a
      // bare cursor move within the same formatting doesn't re-render the toolbar
      // (which selects `selection`); only the bubble, which tracks `geometry`,
      // reacts to reposition.
      selection: sameSummary ? cur.selection : summary,
      selFrom: from,
      selTo: to,
      geometry: cur.geometry + 1
    });
  },
  resetSelection() {
    set({
      selection: EMPTY_SELECTION_SUMMARY,
      selFrom: 0,
      selTo: 0,
      linkEditor: CLOSED_LINK,
      slash: CLOSED_SLASH
    });
  },

  linkEditor: CLOSED_LINK,
  openLinkEditor(href, editing) {
    set({ linkEditor: { open: true, href, editing } });
  },
  closeLinkEditor() {
    set({ linkEditor: CLOSED_LINK });
  },

  slash: CLOSED_SLASH,
  setSlash(query, from) {
    const cur = get().slash;
    // No-op if nothing the menu cares about changed (avoids re-render churn on
    // bare cursor ticks while the trigger is held).
    if (cur.open && cur.query === query && cur.from === from) return;
    // Reset the highlight when the query (and thus the filtered list) changes.
    const index = cur.open && cur.query === query ? cur.index : 0;
    set({ slash: { open: true, query, from, index } });
  },
  setSlashIndex(index) {
    const cur = get().slash;
    if (cur.open && cur.index !== index) set({ slash: { ...cur, index } });
  },
  closeSlash() {
    if (get().slash.open) set({ slash: CLOSED_SLASH });
  }
}));

// The plugin: on each view update where the selection, document, or stored marks
// changed, schedule a single rAF that reads the summary and pushes it. Coalescing
// at the frame boundary means a burst of keystrokes yields at most one push.
export function selectionStatePlugin(): Plugin {
  return new Plugin({
    view() {
      let frame = 0;
      let scheduled = false;
      let live = true;

      const push = (view: EditorView): void => {
        scheduled = false;
        if (!live) return;
        const { from, to } = view.state.selection;
        useRichUiStore
          .getState()
          .setSelection(readSelectionSummary(view.state), from, to);
      };

      const schedule = (view: EditorView): void => {
        if (scheduled) return;
        scheduled = true;
        frame = requestAnimationFrame(() => push(view));
      };

      return {
        update(view, prev) {
          if (
            view.state.selection.eq(prev.selection) &&
            view.state.doc.eq(prev.doc) &&
            view.state.storedMarks === prev.storedMarks
          ) {
            return;
          }
          schedule(view);
        },
        destroy() {
          live = false;
          if (scheduled) cancelAnimationFrame(frame);
          useRichUiStore.getState().resetSelection();
        }
      };
    }
  });
}
