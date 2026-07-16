// Highlight backdrop for a <textarea>. A textarea can only show one native
// selection, and it's invisible while another element (the find bar) holds focus —
// so to paint find matches over textarea source the way the decoration overlay
// paints over the block surface, we mirror the textarea's text into a div behind
// it and wrap the match ranges in <mark>s. The textarea has a transparent
// background (RawSourceView.css), so the marks show through, behind the live text.
//
// The mirror sits in the scroller's own layer, exactly overlapping the textarea's
// centered writing column (it copies the textarea's font, padding and wrap metrics
// so a line wraps in the same place), and its scroll is slaved to the textarea's.
// It's populated only while find is open; empty otherwise, so it costs nothing when
// idle. This is the standard "highlight within textarea" technique.

import type { FindRange } from '../../../lib/find/engine';

// Style properties that must match for the mirror to wrap identically to the
// textarea. Copied from the live computed style so a font/measure preference change
// (which resizes the textarea) is picked up on the next refresh.
const MIRRORED_STYLE = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'maxWidth'
] as const;

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** The mirror's inner HTML: the text verbatim (escaped, whitespace preserved by
 *  white-space: pre-wrap) with each match wrapped in a <mark>, the active one
 *  tagged so it paints distinctly. */
function buildHtml(text: string, hits: readonly FindRange[], activeIndex: number): string {
  if (hits.length === 0) return escapeHtml(text);
  let html = '';
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.start > cursor) html += escapeHtml(text.slice(cursor, hit.start));
    const cls = i === activeIndex ? 'thm-mark thm-mark--active' : 'thm-mark';
    html += `<mark class="${cls}">${escapeHtml(text.slice(hit.start, hit.end))}</mark>`;
    cursor = hit.end;
  });
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  return html;
}

export class TextareaHighlighter {
  private readonly layer: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly onScroll = (): void => this.syncScroll();
  private readonly resizeObserver: ResizeObserver | null;

  /** `container` must be a positioned ancestor of `textarea` (RawSourceView's root
   *  is position: relative). The backdrop layer is inserted before the textarea so
   *  it paints behind it. The layer clips; the content inside is translated to
   *  follow the textarea's scroll. */
  constructor(
    private readonly textarea: HTMLTextAreaElement,
    container: HTMLElement
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'thm-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.content = document.createElement('div');
    this.content.className = 'thm-content';
    this.layer.appendChild(this.content);
    container.insertBefore(this.layer, container.firstChild);

    this.refreshStyles();
    textarea.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => this.refreshStyles())
        : null;
    this.resizeObserver?.observe(textarea);
  }

  /** Copy the textarea's wrap-affecting styles onto the content so a line breaks in
   *  the same place. Called on construction and whenever the textarea resizes. */
  private refreshStyles(): void {
    const cs = getComputedStyle(this.textarea);
    for (const prop of MIRRORED_STYLE) this.content.style[prop] = cs[prop];
    this.syncScroll();
  }

  // Follow the textarea's scroll by translating the content, not by scrolling a
  // second element: a transform composites without a layout, so the marks track the
  // text within the same frame instead of lagging a frame behind (the jitter a
  // synced scrollTop shows during momentum scroll).
  private syncScroll(): void {
    this.content.style.transform = `translate(${-this.textarea.scrollLeft}px, ${-this.textarea.scrollTop}px)`;
  }

  /** Paint the given matches over the current text, tagging the active one, and
   *  scroll the textarea so the active match is in view. */
  render(hits: readonly FindRange[], activeIndex: number): void {
    this.content.innerHTML = buildHtml(this.textarea.value, hits, activeIndex);
    this.syncScroll();
    this.revealActive();
  }

  private revealActive(): void {
    const mark = this.content.querySelector<HTMLElement>('.thm-mark--active');
    if (!mark) return;
    const top = mark.offsetTop;
    const bottom = top + mark.offsetHeight;
    const view = this.textarea.clientHeight;
    if (top < this.textarea.scrollTop) {
      this.textarea.scrollTop = Math.max(0, top - view * 0.25);
    } else if (bottom > this.textarea.scrollTop + view) {
      this.textarea.scrollTop = bottom - view * 0.75;
    }
    this.syncScroll();
  }

  /** Remove all highlights (find closed). */
  clear(): void {
    this.content.innerHTML = '';
  }

  destroy(): void {
    this.textarea.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.layer.remove();
  }
}
