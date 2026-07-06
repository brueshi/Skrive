// @vitest-environment jsdom
//
// Image paste-in (SKR-175 / F26). Before this fix a pasted screenshot did
// nothing at all — onPaste/interpretTransfer read only text flavors, and the
// beforeinput catch-all swallowed the browser's own default. An image on the
// clipboard/drop now claims the gesture ahead of text interpretation and is
// handed to a registered write delegate (ImagePasteDelegate) — the surface
// knows neither the active document's path nor the shell bridge, so these
// tests exercise it with a mocked delegate exactly as production code would
// register one (see BlockEditor.tsx, which wires it to the project store's
// pasteImageAsset action).
//
// jsdom has no real DataTransfer; paste and drop share interpretTransfer
// (SKR-165), so — as the drop and paste-placement suites already do — these
// drive it directly through a minimal fake with an `items` list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BlockSurface, type ImagePasteDelegate } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';
import { notify } from '../../src/lib/notify';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

type Priv = {
  interpretTransfer: (data: DataTransfer, claim: () => void) => boolean;
};
const priv = (s: BlockSurface) => s as unknown as Priv;

function imageFile(mimeType: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], 'clipboard-image', { type: mimeType });
}

// A minimal DataTransfer carrying one file item plus optional text flavors —
// mirrors a real macOS screenshot copy, which carries an image alongside
// incidental text/HTML flavors.
function imageTransfer(file: File, textFlavors: Record<string, string> = {}): DataTransfer {
  return {
    getData: (t: string) => textFlavors[t] ?? '',
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }]
  } as unknown as DataTransfer;
}

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.addRange(r);
}

function blocks(s: BlockSurface): BlockNode[] {
  return s.getDocument().blocks;
}
function firstParagraph(s: BlockSurface): Extract<BlockNode, { type: 'paragraph' }> {
  const p = blocks(s).find((b) => b.type === 'paragraph');
  if (!p || p.type !== 'paragraph') throw new Error('no paragraph');
  return p;
}
function imageUrls(inline: InlineNode[]): string[] {
  return inline.filter((n): n is Extract<InlineNode, { kind: 'image' }> => n.kind === 'image').map((n) => n.url);
}

// Lets the arrayBuffer()/delegate promise chain settle before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('image paste — delegate call and successful insert', () => {
  it('calls the delegate with bytes + MIME + a suggested filename, then splices the link at the caret in one history step', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    caretIn(tn, 5); // end of "hello"

    let seen: { bytes: Uint8Array; mimeType: string; filename: string } | null = null;
    const delegate: ImagePasteDelegate = vi.fn(async (bytes, mimeType, filename) => {
      seen = { bytes, mimeType, filename };
      return 'assets/mock.png';
    });
    surface.onImagePaste(delegate);

    const before = surface.getDocument();
    const claim = vi.fn();
    const file = imageFile('image/png', [1, 2, 3, 4]);
    const handled = priv(surface).interpretTransfer(imageTransfer(file), claim);
    expect(handled).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);

    await flush();

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(seen).not.toBeNull();
    expect(Array.from(seen!.bytes)).toEqual([1, 2, 3, 4]);
    expect(seen!.mimeType).toBe('image/png');
    expect(seen!.filename).toMatch(/^pasted-image-\d+\.png$/);

    const p = firstParagraph(surface);
    expect(inlinePlainText(p.inline)).toBe('hello');
    expect(imageUrls(p.inline)).toEqual(['assets/mock.png']);

    // One undo restores the exact pre-paste doc — the whole gesture (delegate
    // write + splice) is one history step.
    surface.undo();
    expect(surface.getDocument()).toBe(before);
  });
});

describe('image paste — delegate rejection', () => {
  it('toasts, leaves the document untouched, and adds no history step', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    caretIn(tn, 5);

    const errorSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    const delegate: ImagePasteDelegate = vi.fn(async () => {
      throw new Error('write failed');
    });
    surface.onImagePaste(delegate);

    const before = surface.getDocument();
    const claim = vi.fn();
    const file = imageFile('image/png', [1, 2, 3]);
    const handled = priv(surface).interpretTransfer(imageTransfer(file), claim);
    expect(handled).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1); // the gesture is claimed either way

    await flush();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(surface.getDocument()).toBe(before); // nothing landed

    // Nothing was ever recorded: undo is a no-op over the same doc.
    surface.undo();
    expect(surface.getDocument()).toBe(before);
  });

  it('toasts when no delegate is registered at all', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    caretIn(tn, 5);
    const errorSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});

    const before = surface.getDocument();
    const claim = vi.fn();
    const file = imageFile('image/png', [1, 2, 3]);
    const handled = priv(surface).interpretTransfer(imageTransfer(file), claim);
    expect(handled).toBe(true);

    await flush();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(surface.getDocument()).toBe(before);
  });
});

describe('image paste — MIME precedence', () => {
  it('falls through to text interpretation for an unrecognized image MIME (image/tiff)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    caretIn(tn, 5);
    const delegate = vi.fn();
    surface.onImagePaste(delegate);

    const file = imageFile('image/tiff', [1, 2, 3]);
    const claim = vi.fn();
    const handled = priv(surface).interpretTransfer(imageTransfer(file, { 'text/plain': 'X' }), claim);

    expect(handled).toBe(true);
    expect(delegate).not.toHaveBeenCalled();
    expect(inlinePlainText(firstParagraph(surface).inline)).toBe('helloX');
  });

  it('a mixed clipboard (image + text flavors): the image wins', async () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    caretIn(tn, 5);
    const delegate: ImagePasteDelegate = vi.fn(async () => 'assets/mock.png');
    surface.onImagePaste(delegate);

    const file = imageFile('image/png', [1, 2, 3]);
    const dt = imageTransfer(file, { 'text/plain': 'SHOULD NOT LAND', 'text/html': '<p>SHOULD NOT LAND</p>' });
    const claim = vi.fn();
    priv(surface).interpretTransfer(dt, claim);
    await flush();

    expect(delegate).toHaveBeenCalledTimes(1);
    const p = firstParagraph(surface);
    expect(inlinePlainText(p.inline)).not.toContain('SHOULD NOT LAND');
    expect(imageUrls(p.inline)).toEqual(['assets/mock.png']);
  });
});
