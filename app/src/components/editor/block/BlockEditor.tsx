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
import { BlockSurface } from '../../../lib/blocksurface';
import { parseDocument, serializeDocument } from '../../../lib/blockmodel';
import { setActiveEditorFlush } from '../active-editor';
import { setActiveBlockMenu } from '../active-surface';
import { BlockMenuController } from '../menus/BlockMenuController';
import { SelectionBubble } from '../menus/SelectionBubble';
import { LinkEditor } from '../menus/LinkEditor';
import { BlockSlashMenu } from '../menus/BlockSlashMenu';
import './BlockEditor.css';

type Props = {
  /** Initial canonical Markdown body. Read once on mount; uncontrolled thereafter. */
  body: string;
  /** Receives the serialized body on the surface's debounced snapshot. */
  onChange: (next: string) => void;
};

export function BlockEditor({ body, onChange }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [ctx, setCtx] = useState<{ surface: BlockSurface; controller: BlockMenuController } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const surface = new BlockSurface({
      container: host,
      doc: parseDocument(body),
      onDocChange: (doc) => onChangeRef.current(serializeDocument(doc))
    });
    const controller = new BlockMenuController(surface);
    setCtx({ surface, controller });
    setActiveEditorFlush(() => surface.flush());
    setActiveBlockMenu(controller);
    return () => {
      setActiveEditorFlush(null);
      setActiveBlockMenu(null);
      controller.destroy();
      // Drain the pending snapshot before teardown so a tab switch / view
      // toggle within the debounce window doesn't drop the last edit — destroy()
      // only cancels, it never emits. RawSourceView does the same in its cleanup
      // (SKR-154 / F02). The unmounting instance's onChange closure still points
      // at this tab's index, so the flush routes to the right tab.
      surface.flush();
      surface.destroy();
      setCtx(null);
    };
    // Uncontrolled: body is intentionally read once. App remounts per file via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="block-editor">
      <div className="block-editor-body">
        <div ref={hostRef} className="block-editor-surface" />
      </div>
      {ctx && <SelectionBubble controller={ctx.controller} />}
      {ctx && <LinkEditor controller={ctx.controller} />}
      {ctx && <BlockSlashMenu surface={ctx.surface} />}
    </div>
  );
}
