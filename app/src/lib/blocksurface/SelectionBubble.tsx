// The select->bubble affordance (SKR-95, Stage 3c). A floating toolbar over a
// text selection, with the basic inline marks. React renders only this overlay;
// it never touches the editor content (that is the surface's React-free hot
// path). It subscribes to the surface's rAF-coalesced selection observer, so it
// updates on selection change, never per keystroke.
//
// Buttons commit on mousedown with preventDefault, which is what keeps the
// contenteditable selection alive — a normal click would blur the editor and
// collapse the selection before the command runs. Adding a link is the exception:
// the URL input must take focus, so the surface saves the target selection first.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { BlockSurface, SelectionInfo } from './surface';

const BAR_OFFSET = 44; // lift the bar above the selection

function Btn({
  label,
  title,
  active,
  onPress
}: {
  label: string;
  title: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      // Preserve the editor selection: do not let the button steal focus.
      onMouseDown={(e: MouseEvent) => {
        e.preventDefault();
        onPress();
      }}
      style={{
        minWidth: 28,
        height: 28,
        padding: '0 6px',
        border: 'none',
        borderRadius: 6,
        background: active ? 'rgba(255,255,255,0.18)' : 'transparent',
        color: '#f3f4f6',
        font: '600 13px ui-sans-serif, system-ui',
        fontStyle: label === 'I' ? 'italic' : 'normal',
        cursor: 'pointer'
      }}
    >
      {label}
    </button>
  );
}

export function SelectionBubble({ surface }: { surface: BlockSurface }) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    surface.onSelectionChange(setInfo);
    return () => surface.onSelectionChange(null);
  }, [surface]);

  // Leaving link mode whenever the selection goes away keeps the bubble honest.
  useEffect(() => {
    if (!info) {
      setLinking(false);
      setHref('');
    }
  }, [info]);

  useEffect(() => {
    if (linking) inputRef.current?.focus();
  }, [linking]);

  if (!info) return null;
  const { rect, marks } = info;
  const top = Math.max(8, Math.round(rect.top) - BAR_OFFSET);
  const left = Math.round(rect.left);

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 2147483646,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: '#1f2937',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)'
      }}
    >
      {linking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            surface.commitLink(href);
            setLinking(false);
            setHref('');
          }}
        >
          <input
            ref={inputRef}
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                surface.commitLink(null);
                setLinking(false);
                setHref('');
              }
            }}
            placeholder="https://…"
            spellCheck={false}
            style={{
              width: 200,
              height: 26,
              padding: '0 8px',
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 6,
              background: '#111827',
              color: '#f3f4f6',
              font: '13px ui-sans-serif, system-ui',
              outline: 'none'
            }}
          />
        </form>
      ) : (
        <>
          <Btn label="B" title="Bold (Cmd/Ctrl+B)" active={marks.strong} onPress={() => surface.toggleMark('strong')} />
          <Btn label="I" title="Italic (Cmd/Ctrl+I)" active={marks.em} onPress={() => surface.toggleMark('em')} />
          <Btn label="‹›" title="Code (Cmd/Ctrl+E)" active={marks.code} onPress={() => surface.toggleMark('code')} />
          <Btn
            label="Link"
            title="Link"
            active={marks.link}
            onPress={() => {
              if (marks.link) surface.setLink(null);
              else if (surface.beginLink()) setLinking(true);
            }}
          />
        </>
      )}
    </div>
  );
}
