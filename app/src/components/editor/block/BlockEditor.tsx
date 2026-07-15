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

import { useEffect, useRef, useState } from 'react';
import { BlockSurface, DocHistory } from '../../../lib/blocksurface';
import { attachCustomCaret } from '../../../lib/blocksurface/caret';
import type { Document } from '../../../lib/blockmodel';
import { setActiveEditorFlush } from '../active-editor';
import { setActiveBlockMenu } from '../active-surface';
import { BlockMenuController } from '../menus/BlockMenuController';
import { SelectionBubble } from '../menus/SelectionBubble';
import { LinkEditor } from '../menus/LinkEditor';
import { BlockSlashMenu } from '../menus/BlockSlashMenu';
import { BlockTagMenu } from '../menus/BlockTagMenu';
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
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [ctx, setCtx] = useState<{ surface: BlockSurface; controller: BlockMenuController } | null>(null);
  const showWordCount = usePreferencesStore((s) => s.showWordCount);
  const [counts, setCounts] = useState<LiveCounts | null>(null);

  // Live counts off the surface DOM (SKR-53): per-block incremental via
  // MutationObserver, rAF-coalesced — real-time without touching the
  // keystroke hot path. Detached entirely while the badge is toggled off.
  useEffect(() => {
    if (!showWordCount) {
      setCounts(null);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    return attachLiveCounts(host, setCounts);
  }, [showWordCount]);

  useEffect(() => {
    const host = hostRef.current;
    const scroller = bodyRef.current;
    const caretEl = caretRef.current;
    if (!host || !scroller || !caretEl) return;
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
    setCtx({ surface, controller });
    setActiveEditorFlush(() => surface.flush());
    setActiveBlockMenu(controller);
    return () => {
      setActiveEditorFlush(null);
      setActiveBlockMenu(null);
      controller.destroy();
      caret.destroy();
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
        <div ref={caretRef} className="skrive-caret" aria-hidden="true" />
      </div>
      {/* Document-structure rail (SKR-229), same component the Markdown preview
          mounts. It measures the surface's real h1-h6 elements and navigates by
          scroll offset, so no block-id plumbing is needed; renderKey stays
          constant and structural edits reach it through its ResizeObserver +
          element-identity path (see the rail's Props comment). */}
      <OutlineRail
        scrollerRef={bodyRef}
        contentRef={hostRef}
        renderKey=""
      />
      {showWordCount && counts && (
        <WordCountBadge counts={counts} scopeRef={bodyRef} />
      )}
      {ctx && <SelectionBubble controller={ctx.controller} />}
      {ctx && <LinkEditor controller={ctx.controller} />}
      {ctx && <BlockSlashMenu surface={ctx.surface} />}
      {ctx && <BlockTagMenu surface={ctx.surface} />}
    </div>
  );
}
