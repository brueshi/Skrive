// Hover peek for footnote references (SKR-56). Hovering a `[^label]` superscript
// shows a small popover with that footnote's definition text, so a reader can read
// the note without jumping to the footer. View-only: it reads the rendered
// definition and never touches the model, the editable DOM, or the caret.
//
// One delegated listener on the surface host (references come and go as blocks
// re-render, so per-element listeners would leak); one reused popover element on
// document.body, positioned in viewport space against the reference's rect. A short
// close delay lets the pointer travel from the reference onto the popover without it
// vanishing.

import { FOOTNOTE_REF_ATTR } from './render';

export type FootnotePeekHandle = { destroy(): void };

const CLOSE_DELAY_MS = 120;

/** The definition body text for a label: the blocks inside the definition's body
 *  wrapper (the marker and delete chrome live outside it), joined. Empty when
 *  there is no definition. */
function definitionText(surface: HTMLElement, label: string): string {
  const body = surface.querySelector<HTMLElement>(
    `.sk-footnote-def[data-footnote-label="${CSS.escape(label)}"] > .sk-footnote-def-body`
  );
  if (!body) return '';
  const parts: string[] = [];
  for (const child of Array.from(body.children)) {
    const t = child.textContent?.trim();
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

export function attachFootnotePeek(surface: HTMLElement): FootnotePeekHandle {
  const pop = document.createElement('div');
  pop.className = 'sk-footnote-peek';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.appendChild(pop);

  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const hide = (): void => {
    pop.hidden = true;
  };
  const scheduleHide = (): void => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = setTimeout(hide, CLOSE_DELAY_MS);
  };
  const cancelHide = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const show = (ref: HTMLElement): void => {
    const label = ref.dataset.footnoteLabel ?? '';
    const text = definitionText(surface, label);
    if (!text) return;
    cancelHide();
    pop.textContent = text;
    pop.hidden = false;
    // Position above the reference, clamped into the viewport. Measured after the
    // content is set so the height is real.
    const r = ref.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const margin = 8;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    let top = r.top - ph - 6;
    if (top < margin) top = r.bottom + 6; // flip below when there's no room above
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const onOver = (e: Event): void => {
    const target = e.target;
    const ref = target instanceof Element ? target.closest<HTMLElement>(`[${FOOTNOTE_REF_ATTR}]`) : null;
    if (ref) show(ref);
  };
  const onOut = (e: Event): void => {
    const target = e.target;
    const ref = target instanceof Element ? target.closest<HTMLElement>(`[${FOOTNOTE_REF_ATTR}]`) : null;
    if (ref) scheduleHide();
  };

  surface.addEventListener('mouseover', onOver);
  surface.addEventListener('mouseout', onOut);
  // Keep the popover open while the pointer is on it (to read/scroll), close on leave.
  pop.addEventListener('mouseenter', cancelHide);
  pop.addEventListener('mouseleave', scheduleHide);
  // A reflow that could move the anchor should not leave a stale popover floating.
  const onScroll = (): void => hide();
  window.addEventListener('scroll', onScroll, true);

  return {
    destroy(): void {
      cancelHide();
      surface.removeEventListener('mouseover', onOver);
      surface.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onScroll, true);
      pop.remove();
    }
  };
}
