// The bespoke block surface, wired into the app (SKR-95). The only editor since
// the cutover (SKR-111). Uncontrolled: the body is read once on mount; App keys
// this by the active tab path so a file switch remounts. Edits flow out as a
// debounced serialized snapshot, and the active-editor flush hook drains a
// pending snapshot on ⌘S / quit / source-view toggle. React mounts the surface
// and renders the affordance overlays; the keystroke hot path runs in plain DOM.
//
// The selection bubble and link editor are the shared production menus (SKR-114),
// driven by a BlockMenuController over the surface; only the slash menu keeps a
// bespoke driver (BlockSlashMenu). The fixed formatting toolbar moved up to the
// persistent EditorBar band (SKR-123), which reads this controller from the
// active-surface registry rather than rendering it inside the editor.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockSurface, DocHistory } from '../../../lib/blocksurface';
import { attachCustomCaret } from '../../../lib/blocksurface/caret';
import { attachDecorationOverlay } from '../../../lib/blocksurface/decoration-overlay';
import { attachFocusActive } from '../../../lib/blocksurface/focus-active';
import { attachTableChrome } from '../../../lib/blocksurface/table-chrome';
import { attachCodeHighlight } from '../../../lib/blocksurface/highlight/code-highlight';
import { attachFootnotePeek } from '../../../lib/blocksurface/footnote-peek';
import { attachSpellcheck, type SpellcheckHandle } from '../../../lib/spellcheck/checker';
import { SpellDictionary } from '../../../lib/spellcheck/dictionary';
import { hostSpellProvider } from '../../../lib/spellcheck/provider';
import { installDecorationDevHarness } from '../../../lib/blocksurface/decoration-dev';
import type { Document } from '../../../lib/blockmodel';
import { setActiveEditorFlush } from '../active-editor';
import { setActiveBlockMenu } from '../active-surface';
import { BlockMenuController } from '../menus/BlockMenuController';
import { SelectionBubble } from '../menus/SelectionBubble';
import { LinkEditor } from '../menus/LinkEditor';
import { BlockSlashMenu } from '../menus/BlockSlashMenu';
import { BlockTableMenu } from '../menus/BlockTableMenu';
import { BlockTagMenu } from '../menus/BlockTagMenu';
import { CodeLangMenu } from '../menus/CodeLangMenu';
import { FindBar } from '../find/FindBar';
import { BlockFindTarget } from '../find/FindTarget';
import { OutlineRail } from '../OutlineRail';
import { WordCountBadge } from '../WordCountBadge';
import { attachLiveCounts, type LiveCounts } from '../../../lib/wordcount/live';
import { usePreferencesStore } from '../../../stores/preferences';
import { useProjectStore } from '../../../stores/project';
import { skriveAssetResolver } from '../../../lib/preview/imageResolver';
import './BlockEditor.css';

// Model-in / model-out (SKR-196). The surface edits the canonical block model
// directly; serialization is the caller's concern, not the editor's. This is the
// rich `.folio` editor: it mounts with the model as the canonical store and no
// Markdown serializer in sight. Markdown files never mount this — they edit raw
// text (RawSourceView) with a rendered preview (SKR-197).
type Props = {
  /** Initial block-model document. Read once on mount; uncontrolled thereafter. */
  doc: Document;
  /** The document's project-relative path. Read once on mount (App remounts this
   *  component per file via `key`). Resolves where a pasted image's sibling
   *  `assets/` folder lands (SKR-175) and anchors the surface's asset-URL resolver
   *  so image srcs load in the shell (SKR-223). */
  docPath: string;
  /** The tab's session undo history (SKR-179). Read once on mount and handed to
   *  the surface, so undo survives the remount a tab switch causes. Absent in
   *  tests -> the surface keeps a private history. */
  history?: DocHistory;
  /** Receives the edited document on the surface's debounced snapshot. */
  onChange: (next: Document) => void;
};

export function BlockEditor({ doc, docPath, history, onChange }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const decorationRef = useRef<HTMLDivElement>(null);
  const tableChromeRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [ctx, setCtx] = useState<{
    surface: BlockSurface;
    controller: BlockMenuController;
    findTarget: BlockFindTarget;
  } | null>(null);
  const showWordCount = usePreferencesStore((s) => s.showWordCount);
  const focusMode = useProjectStore((s) => s.focusMode);
  const [counts, setCounts] = useState<LiveCounts | null>(null);
  const spellcheckOn = usePreferencesStore((s) => s.spellcheck);
  const personalDictionary = usePreferencesStore((s) => s.personalDictionary);
  const projectWords = useProjectStore((s) => s.manifest?.config.dictionary.projectWords);
  // The two word lists as one membership test, rebuilt only when either changes.
  // Held in a ref as well so the checker reads the CURRENT dictionary on every
  // paint without being rebuilt when a word is taught.
  const dictionary = useMemo(
    () => new SpellDictionary(personalDictionary, projectWords ?? []),
    [personalDictionary, projectWords]
  );
  const dictionaryRef = useRef(dictionary);
  dictionaryRef.current = dictionary;
  const spellcheckRef = useRef<SpellcheckHandle | null>(null);

  // Live counts off the surface DOM (SKR-53): per-block incremental via
  // MutationObserver, rAF-coalesced — real-time without touching the
  // keystroke hot path. Detached entirely while the badge is toggled off.
  useEffect(() => {
    if (!showWordCount || focusMode) {
      setCounts(null);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    return attachLiveCounts(host, setCounts);
  }, [showWordCount, focusMode]);

  // Focus mode's active-block marker (SKR-52). Attached only while the mode is
  // on — off, there is no listener at all. Depends on `ctx` because it needs the
  // constructed surface's structural-change signal, so it can only run once the
  // mount effect below has published one.
  useEffect(() => {
    if (!focusMode || !ctx) return;
    const host = hostRef.current;
    if (!host) return;
    const handle = attachFocusActive({ surface: host, blockSurface: ctx.surface });
    return () => handle.destroy();
  }, [focusMode, ctx]);

  // Spellchecking. Attached only when the writer wants it AND this host has a
  // spelling oracle to ask — a host without one leaves the surface exactly as it
  // was, with no controller, no listeners and no round trips. The provider probe
  // is async, so the effect guards against resolving after unmount.
  useEffect(() => {
    if (!spellcheckOn || !ctx) return;
    const host = hostRef.current;
    const scroller = bodyRef.current;
    if (!host || !scroller) return;
    let cancelled = false;
    void hostSpellProvider().then((provider) => {
      if (cancelled || !provider) return;
      spellcheckRef.current = attachSpellcheck({
        surface: host,
        scroller,
        blockSurface: ctx.surface,
        provider,
        dictionary: () => dictionaryRef.current
      });
    });
    return () => {
      cancelled = true;
      spellcheckRef.current?.destroy();
      spellcheckRef.current = null;
    };
  }, [spellcheckOn, ctx]);

  // Teaching a word only filters answers that are already cached, so a change to
  // either dictionary repaints rather than re-checking.
  useEffect(() => {
    spellcheckRef.current?.repaint();
  }, [dictionary]);

  useEffect(() => {
    const host = hostRef.current;
    const scroller = bodyRef.current;
    const caretEl = caretRef.current;
    const decorationEl = decorationRef.current;
    const tableChromeEl = tableChromeRef.current;
    if (!host || !scroller || !caretEl || !decorationEl || !tableChromeEl) return;
    const surface = new BlockSurface({
      container: host,
      doc,
      history,
      onDocChange: (next) => onChangeRef.current(next),
      // Resolve model image srcs onto the shell's asset origin at render time
      // (SKR-223). The same helper the Markdown preview uses (one resolver, two
      // consumers), bound to this document's path so a relative `assets/…` src —
      // which the webview can't load against the app's document origin — becomes a
      // loadable `skrive-asset://…` URL. Passed at construction so images already
      // in the doc resolve on the first paint, not just ones pasted afterward. The
      // raw relative path stays in the model; this is view-only.
      resolveAsset: (rawUrl) => skriveAssetResolver(rawUrl, { projectRoot: '', filePath: docPath })
    });
    const caret = attachCustomCaret({ surface: host, scroller, caret: caretEl });
    // The block decoration overlay (find-match highlights, spelling squiggles):
    // paints the surface's decoration store over live text in the scroller's
    // content space, alongside the caret. View-only; the store is empty until a
    // feature adds a decoration, so it is inert until find/spellcheck arrive.
    const decorations = attachDecorationOverlay({
      surface: host,
      scroller,
      layer: decorationEl,
      store: surface.decorations
    });
    // Dev-only console hook to seed decorations (window.__skrive.decorate), so the
    // overlay is verifiable in the shell before its consumers exist. Stripped from
    // production builds.
    const teardownDevHarness = import.meta.env.DEV
      ? installDecorationDevHarness(host, surface.decorations)
      : null;
    // Syntax highlighting (SKR-262): the painter owns an off-thread worker that
    // tokenizes code blocks and stacks a colour mirror behind the real editable
    // text. View-only and debounced, so it never touches the keystroke path.
    const highlight = attachCodeHighlight({ surface: host, store: surface.highlight });
    // Table hover chrome: gutters with per-row/column grips and `+` inserts,
    // built only while a table is hovered or focused. Measures real cell geometry
    // (column widths are browser-decided and absent from the model) and rebuilds
    // off the surface's structural-change signal, never the keystroke path.
    const tableChrome = attachTableChrome({
      surface: host,
      scroller,
      layer: tableChromeEl,
      blockSurface: surface
    });
    // Footnote hover peek (SKR-56): shows a reference's definition text on hover.
    // View-only, delegated off the host; the ref<->def jump lives in the surface.
    const footnotePeek = attachFootnotePeek(host);
    const controller = new BlockMenuController(surface);
    // The write seam (SKR-175): the surface can read a pasted image's bytes but
    // owns neither docPath nor the shell bridge, so it hands both to the store
    // action that does. A rejection here is what the surface's own catch turns
    // into a toast — this delegate deliberately doesn't swallow the error.
    surface.onImagePaste((bytes, _mimeType, filename) =>
      useProjectStore.getState().pasteImageAsset(docPath, filename, bytes)
    );
    // Clicking an inline tag chip scopes the sidebar's All list to that tag.
    surface.onTagClick((name) =>
      useProjectStore.getState().setFilter({ kind: 'tag', value: name })
    );
    setCtx({ surface, controller, findTarget: new BlockFindTarget(surface) });
    setActiveEditorFlush(() => surface.flush());
    setActiveBlockMenu(controller);
    return () => {
      setActiveEditorFlush(null);
      setActiveBlockMenu(null);
      controller.destroy();
      caret.destroy();
      decorations.destroy();
      tableChrome.destroy();
      highlight.destroy();
      footnotePeek.destroy();
      teardownDevHarness?.();
      // Drain the pending snapshot before teardown so a tab switch / view
      // toggle within the debounce window doesn't drop the last edit — destroy()
      // only cancels, it never emits. RawSourceView does the same in its cleanup
      // (SKR-154 / F02). The unmounting instance's onChange closure still points
      // at this tab's index, so the flush routes to the right tab.
      surface.flush();
      surface.destroy();
      setCtx(null);
    };
    // Uncontrolled: doc is intentionally read once. App remounts per file via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="block-editor">
      {/* Side-gutter clicks land on the scroller, outside the centered surface,
          so the surface's own click listener never sees them — route them to its
          nearest-position placement (SKR-192). Only clicks on the scroller
          itself: a click inside the surface bubbles up here too, but native
          placement (or the surface's handler) already owns it. */}
      <div
        ref={bodyRef}
        className="block-editor-body"
        onClick={(e) => {
          if (e.target === e.currentTarget) ctx?.surface.placeCaretNearPoint(e.clientX, e.clientY);
        }}
      >
        <div ref={hostRef} className="block-editor-surface" />
        {/* Decoration overlay layer: highlights / squiggles painted over the text
            in scroller-content space. Between the surface and the caret so boxes sit
            over the text but under the caret; pointer-events:none. */}
        <div ref={decorationRef} className="block-decoration-layer" aria-hidden="true" />
        {/* Table hover chrome: row/column grips and + inserts, in the same
            content coordinate space. Above the decoration layer so the gutters
            are never buried; the layer itself is pointer-transparent and only
            its buttons take input. */}
        <div ref={tableChromeRef} className="block-table-chrome-layer" />
        <div ref={caretRef} className="skrive-caret" aria-hidden="true" />
      </div>
      {/* Document-structure rail (SKR-229), same component the Markdown preview
          mounts. It measures the surface's real h1-h6 elements and navigates by
          scroll offset, so no block-id plumbing is needed; renderKey stays
          constant and structural edits reach it through its ResizeObserver +
          element-identity path (see the rail's Props comment). */}
      {/* Focus mode strips both ambient readouts by unmounting them, not by
          hiding them in CSS: their observers (the rail's ResizeObserver, the
          counts' MutationObserver) then stop too, so the mode costs less than
          normal editing rather than more. */}
      {!focusMode && (
        <OutlineRail
          scrollerRef={bodyRef}
          contentRef={hostRef}
          renderKey=""
        />
      )}
      {showWordCount && !focusMode && counts && (
        <WordCountBadge counts={counts} scopeRef={bodyRef} />
      )}
      {ctx && <FindBar target={ctx.findTarget} />}
      {ctx && <SelectionBubble controller={ctx.controller} />}
      {ctx && <LinkEditor controller={ctx.controller} />}
      {ctx && <BlockSlashMenu surface={ctx.surface} />}
      {ctx && <BlockTableMenu surface={ctx.surface} />}
      {ctx && <BlockTagMenu surface={ctx.surface} />}
      {ctx && <CodeLangMenu surface={ctx.surface} />}
    </div>
  );
}
