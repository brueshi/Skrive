// The bespoke block surface, wired into the app (SKR-95, Stage 3h). Mirrors the
// RichEditor contract: uncontrolled (the body is read once on mount; App keys
// this by the active tab path so a file switch remounts), edits flow out as a
// debounced serialized snapshot, and the active-editor flush hook drains a
// pending snapshot on ⌘S / quit. React mounts the surface and renders the
// affordance overlays; the keystroke hot path runs in plain DOM.

import { useEffect, useRef, useState } from 'react';
import { BlockSurface, SelectionBubble, SlashMenu } from '../../../lib/blocksurface';
import { parseDocument, serializeDocument } from '../../../lib/blockmodel';
import { setActiveEditorFlush } from '../active-editor';
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
  const [surface, setSurface] = useState<BlockSurface | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const s = new BlockSurface({
      container: host,
      doc: parseDocument(body),
      onDocChange: (doc) => onChangeRef.current(serializeDocument(doc))
    });
    setSurface(s);
    setActiveEditorFlush(() => s.flush());
    return () => {
      setActiveEditorFlush(null);
      s.destroy();
      setSurface(null);
    };
    // Uncontrolled: body is intentionally read once. App remounts per file via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="block-editor">
      <div ref={hostRef} className="block-editor-surface" />
      {surface && <SelectionBubble surface={surface} />}
      {surface && <SlashMenu surface={surface} />}
    </div>
  );
}
