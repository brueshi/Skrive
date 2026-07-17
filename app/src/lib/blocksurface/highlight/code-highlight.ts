// The DOM half of syntax highlighting — the painter for a HighlightBus. It owns
// the highlight Worker and, for each code block, an inert colour "mirror": a second
// <code> stacked behind the real editable one (CSS grid, same cell) whose token
// spans carry the colour the real text is made transparent to reveal. The editable
// <code> itself is NEVER touched, so every just-fixed code-block behaviour and the
// WKWebView caret path stay exactly as they were — highlighting is pure additive
// paint that cannot corrupt editing.
//
// Nothing here runs on the keystroke path. An edit only (a) toggles the block into
// `is-editing` — real text shows in the default colour, the stale mirror hides, no
// per-keystroke reflow — and (b) arms a trailing debounce. When typing settles, the
// block's text is tokenized off-thread and the mirror is rebuilt and revealed. So
// colour "resolves" a beat after you pause; it never blocks a keystroke.

import { BLOCK_ID_ATTR, CHROME_ATTR, HL_MIRROR_ATTR } from '../render';
import { isSupportedLanguage } from './languages';
import type { HighlightBus } from './highlight-bus';
import type {
  HighlightRequest,
  HighlightResponse,
  HighlightToken
} from './highlight-worker-protocol';

export type CodeHighlightOptions = {
  /** The contenteditable host (`.block-editor-surface`) whose `<pre>` code blocks
   *  are highlighted. */
  surface: HTMLElement;
  /** The surface's highlight invalidation channel. */
  store: HighlightBus;
};

export type CodeHighlightHandle = { destroy(): void };

// Milliseconds of typing quiet before a block is (re)tokenized. Long enough that a
// burst of keystrokes costs one tokenize, short enough that colour feels prompt.
const DEBOUNCE_MS = 90;

const HIGHLIGHTED_CLASS = 'has-highlight';
const EDITING_CLASS = 'is-editing';

/** The real editable `<code>` of a code block `<pre>` (never the mirror). */
function realCode(pre: HTMLElement): HTMLElement | null {
  return pre.querySelector<HTMLElement>(`:scope > code:not([${HL_MIRROR_ATTR}])`);
}

/** Build the mirror's coloured children from flat, sorted, non-overlapping token
 *  spans: a text node for each gap, a classed <span> for each token. The spans'
 *  combined text is exactly `text`, so the mirror lays out identically to the real
 *  code (same font, same `white-space: pre`) and aligns for free. */
function buildMirrorChildren(text: string, tokens: readonly HighlightToken[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const tk of tokens) {
    if (tk.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, tk.start)));
    const span = document.createElement('span');
    span.className = `sk-hl sk-hl-${tk.type}`;
    span.textContent = text.slice(tk.start, tk.end);
    frag.appendChild(span);
    pos = tk.end;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  return frag;
}

/** Wire a code-highlight painter to a surface. Returns a handle whose destroy()
 *  terminates the worker and removes every mirror. Mirrors attachDecorationOverlay's
 *  lifecycle. */
export function attachCodeHighlight({ surface, store }: CodeHighlightOptions): CodeHighlightHandle {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // No worker (e.g. an environment that can't spawn one): highlighting is a
    // progressive enhancement, so degrade silently to plain monospace.
    return { destroy() {} };
  }

  // Per-block monotonic request id, and the text each in-flight request was made
  // against — the response carries neither, so we hold the text here and only
  // reveal a mirror that still matches the block's on-screen text.
  const seqByBlock = new Map<string, number>();
  const pending = new Map<string, { seq: number; text: string }>();

  // Coalesced repaint work for the next debounce tick. `reassessAll` (a structural
  // reconcile) supersedes the per-block set.
  const dirty = new Set<string>();
  let reassessAll = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const preById = (id: string): HTMLElement | null =>
    surface.querySelector<HTMLElement>(`pre[${BLOCK_ID_ATTR}="${id}"]`);

  /** Strip highlighting from a block entirely (unknown/empty language, or empty
   *  text): drop the mirror and both classes so the real code renders plainly. */
  const clear = (pre: HTMLElement): void => {
    pre.querySelector(`:scope > code[${HL_MIRROR_ATTR}]`)?.remove();
    pre.classList.remove(HIGHLIGHTED_CLASS, EDITING_CLASS);
  };

  /** Send one block to the worker (or clear it when it can't highlight). */
  const request = (id: string): void => {
    const pre = preById(id);
    if (!pre) return;
    const code = realCode(pre);
    if (!code) return;
    const lang = pre.dataset.lang ?? '';
    const text = code.textContent ?? '';
    if (text === '' || !isSupportedLanguage(lang)) {
      pending.delete(id);
      clear(pre);
      return;
    }
    const seq = (seqByBlock.get(id) ?? 0) + 1;
    seqByBlock.set(id, seq);
    pending.set(id, { seq, text });
    const msg: HighlightRequest = { type: 'highlight', seq, blockId: id, lang, text };
    worker!.postMessage(msg);
  };

  const flush = (): void => {
    timer = null;
    if (destroyed) return;
    const ids = reassessAll
      ? Array.from(surface.querySelectorAll<HTMLElement>(`pre[${BLOCK_ID_ATTR}]`), (pre) =>
          pre.getAttribute(BLOCK_ID_ATTR)!
        )
      : [...dirty];
    reassessAll = false;
    dirty.clear();
    for (const id of ids) request(id);
  };

  const arm = (): void => {
    if (timer !== null || destroyed) return;
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  const onInvalidate = (invalidated: readonly string[] | null): void => {
    if (invalidated === null) {
      reassessAll = true;
    } else {
      for (const id of invalidated) {
        dirty.add(id);
        // An edit landed: show the real (default-colour) text and hide the now-stale
        // mirror until the debounce rebuilds it. Only meaningful once the block has a
        // mirror; a class toggle, so it is free on the keystroke path.
        preById(id)?.classList.add(EDITING_CLASS);
      }
    }
    arm();
  };

  const onMessage = (event: MessageEvent<HighlightResponse>): void => {
    const msg = event.data;
    if (msg.type !== 'tokens' || destroyed) return;
    const req = pending.get(msg.blockId);
    // Drop a result the block has already moved past (a newer request is queued).
    if (!req || req.seq !== msg.seq) return;
    pending.delete(msg.blockId);
    const pre = preById(msg.blockId);
    if (!pre) return;
    const code = realCode(pre);
    // Only reveal a mirror that matches what is on screen. If the block's text has
    // changed since the request went out, keep it in `is-editing` (plain text) and
    // let the newer request's result land instead — never flash a misaligned mirror.
    if (!code || (code.textContent ?? '') !== req.text) return;
    if (msg.tokens.length === 0) {
      clear(pre);
      return;
    }
    let mirror = pre.querySelector<HTMLElement>(`:scope > code[${HL_MIRROR_ATTR}]`);
    if (!mirror) {
      mirror = document.createElement('code');
      mirror.setAttribute(HL_MIRROR_ATTR, '');
      // Chrome, not content: the offset/caret walkers skip it (shared with the
      // language button and any future per-block chrome).
      mirror.setAttribute(CHROME_ATTR, '');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.contentEditable = 'false';
      // LAST child, so the real code stays the one `querySelector('code')` and the
      // offset fast path (a Range ending before it) ever see. It shares the grid
      // cell with the real code and, painting on top of the now-transparent real
      // text, supplies the colour; pointer-events:none lets clicks fall through.
      pre.appendChild(mirror);
    }
    mirror.textContent = '';
    mirror.appendChild(buildMirrorChildren(req.text, msg.tokens));
    pre.classList.add(HIGHLIGHTED_CLASS);
    pre.classList.remove(EDITING_CLASS);
  };

  worker.onmessage = onMessage;
  worker.onerror = (event) => {
    // Highlighting is a progressive enhancement — a worker failure must never take
    // the editor with it. Surface it in dev, then leave blocks as plain monospace.
    if (import.meta.env.DEV) console.warn('code highlight worker error', event.message || event);
  };
  const unsubscribe = store.subscribe(onInvalidate);
  // Paint whatever is already present (initial mount / a document just loaded).
  reassessAll = true;
  arm();

  return {
    destroy(): void {
      destroyed = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      for (const mirror of surface.querySelectorAll(`code[${HL_MIRROR_ATTR}]`)) mirror.remove();
    }
  };
}
