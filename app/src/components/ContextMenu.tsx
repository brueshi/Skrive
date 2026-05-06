// Reusable floating context menu.
//
// Positioned at an anchor point (usually right-click coords), closed by
// Escape, click-outside, or any item activation. Arrow-key navigation +
// Enter activates — the first non-disabled item is auto-focused so
// keyboard users never need the mouse.
//
// Visual language matches the rest of the app: borders, not shadows.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  /** Right-aligned keyboard hint. */
  shortcut?: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
};

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onDismiss: () => void;
};

export function ContextMenu({ x, y, items, onDismiss }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(() => {
    const i = items.findIndex((it) => !it.disabled);
    return i === -1 ? 0 : i;
  });

  // Clamp so the menu never renders off-screen. Measured after mount
  // because we need the actual dimensions.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    setPos({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop))
    });
    // Focus the first non-disabled item.
    const buttons = el.querySelectorAll<HTMLButtonElement>('button');
    buttons[focusedIndex]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  function activate(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    onDismiss();
    queueMicrotask(() => item.onClick());
  }

  function moveFocus(delta: number) {
    if (items.length === 0) return;
    let next = focusedIndex;
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next]?.disabled) break;
    }
    setFocusedIndex(next);
    const el = menuRef.current;
    el?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(focusedIndex);
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      onDismiss();
    }
  }

  return (
    <div
      className="ctx-backdrop"
      onMouseDown={handleBackdrop}
      onContextMenu={handleBackdrop}
      role="presentation"
    >
      <div
        ref={menuRef}
        className="ctx-menu"
        role="menu"
        onKeyDown={handleKey}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos ? 'visible' : 'hidden'
        }}
      >
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${item.variant === 'destructive' ? ' destructive' : ''}`}
            disabled={item.disabled}
            onClick={() => activate(i)}
            onMouseEnter={() => setFocusedIndex(i)}
          >
            <span className="ctx-label">{item.label}</span>
            {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
