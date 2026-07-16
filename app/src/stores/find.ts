// In-document find/replace UI state. Deliberately small: it holds only the bar's
// intent (open, which fields are showing, the query text, the flags) — the matches
// and the active index are editor-derived and live in the FindBar, computed from
// the active surface, so this store never holds anything that can go stale against
// the document. The global ⌘F binding flips `open`; the bar renders off it.
//
// Query and flags persist across close/reopen (reopening ⌘F keeps the last search,
// as every editor does). `focusNonce` bumps on every open request so pressing ⌘F
// while the bar is already open still re-focuses and selects the input.

import { create } from 'zustand';
import type { FindFlags } from '../lib/find/engine';

type FindState = {
  open: boolean;
  replaceVisible: boolean;
  query: string;
  replacement: string;
  flags: FindFlags;
  focusNonce: number;
  openFind: () => void;
  openReplace: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  toggleFlag: (flag: keyof FindFlags) => void;
};

export const useFindStore = create<FindState>((set) => ({
  open: false,
  replaceVisible: false,
  query: '',
  replacement: '',
  flags: { caseSensitive: false, wholeWord: false, regex: false },
  focusNonce: 0,
  openFind: () => set((s) => ({ open: true, replaceVisible: false, focusNonce: s.focusNonce + 1 })),
  openReplace: () => set((s) => ({ open: true, replaceVisible: true, focusNonce: s.focusNonce + 1 })),
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  setReplacement: (replacement) => set({ replacement }),
  toggleFlag: (flag) => set((s) => ({ flags: { ...s.flags, [flag]: !s.flags[flag] } }))
}));
