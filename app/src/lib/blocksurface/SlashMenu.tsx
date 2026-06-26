// The insert (slash) menu (SKR-95, Stage 3d). Typing `/` on an empty block opens
// it; the text after the `/` filters; Arrow/Enter select; Escape (or deleting the
// `/`) closes. Like the bubble, React renders only this overlay and never touches
// editor content — it subscribes to the surface's slash observer and commits on
// mousedown+preventDefault so the caret survives the click.
//
// While open, a capture-phase keydown intercepts Arrow/Enter/Escape before the
// editor's beforeinput, so Enter selects the item instead of splitting the block.
//
// Stage 3d ships the block types that are fully editable with the inline-text hot
// path; container blocks (quote / list / code / table) arrive with nested-block
// editing in the next sub-stage.

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { BlockSurface, BlockTypeSpec, SlashMenuState } from './surface';

type Item = { title: string; hint: string; keywords: string; spec: BlockTypeSpec };

const ITEMS: Item[] = [
  { title: 'Text', hint: 'Plain paragraph', keywords: 'text paragraph body plain', spec: { kind: 'paragraph' } },
  { title: 'Heading 1', hint: 'Large heading', keywords: 'h1 heading title', spec: { kind: 'heading', level: 1 } },
  { title: 'Heading 2', hint: 'Medium heading', keywords: 'h2 heading subtitle', spec: { kind: 'heading', level: 2 } },
  { title: 'Heading 3', hint: 'Small heading', keywords: 'h3 heading', spec: { kind: 'heading', level: 3 } },
  { title: 'Divider', hint: 'Horizontal rule', keywords: 'divider rule separator hr line', spec: { kind: 'divider' } }
];

function filterItems(query: string): Item[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter((it) => it.title.toLowerCase().includes(q) || it.keywords.includes(q));
}

export function SlashMenu({ surface }: { surface: BlockSurface }) {
  const [state, setState] = useState<SlashMenuState | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    surface.onSlashMenu(setState);
    return () => surface.onSlashMenu(null);
  }, [surface]);

  const items = useMemo(() => filterItems(state?.query ?? ''), [state?.query]);

  // Keep the active index in range as the filter narrows.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[active];
        if (item) surface.applySlashCommand(item.spec);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        surface.closeSlash();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [state, items, active, surface]);

  if (!state) return null;
  if (items.length === 0) return null;

  const top = Math.round(state.rect.bottom) + 6;
  const left = Math.round(state.rect.left);

  return (
    <div
      role="listbox"
      aria-label="Insert block"
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 2147483646,
        minWidth: 220,
        background: '#1f2937',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
        font: '13px ui-sans-serif, system-ui',
        color: '#f3f4f6'
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e: MouseEvent) => {
            e.preventDefault();
            surface.applySlashCommand(item.spec);
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            width: '100%',
            gap: 1,
            padding: '6px 8px',
            border: 'none',
            borderRadius: 6,
            background: i === active ? 'rgba(255,255,255,0.12)' : 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            textAlign: 'left'
          }}
        >
          <span style={{ fontWeight: 600 }}>{item.title}</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{item.hint}</span>
        </button>
      ))}
    </div>
  );
}
