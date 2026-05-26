// CodeMirror clipboard wiring. Thin by design: it reads the selection, hands
// off to the pure copy-out logic in `lib/clipboard`, and writes the result to
// the DOM clipboard event. No conversion logic lives here.
//
// Scope: copy and cut from the editor surface (Stage 1) and paste-in
// conversion (Stage 2). The read-only preview pane is handled elsewhere.

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { toast } from 'sonner';
import { buildClipboardPayload, selectionMarkdown } from '../../lib/clipboard/copyOut';
import { markdownForPaste } from '../../lib/clipboard/htmlToMarkdown';
import {
  imageExtension,
  imageMarkdownLink,
  imagePasteTarget,
  pastedImageFilename
} from '../../lib/clipboard/pasteImage';
import { selectActiveTab, useProjectStore } from '../../stores/project';

// Write both representations and claim the event. Returns false (declining the
// event) when the environment exposes no clipboardData, so the editor's
// default handling still runs.
function writeSelection(event: ClipboardEvent, md: string): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const { text, html } = buildClipboardPayload(md);
  data.setData('text/plain', text);
  data.setData('text/html', html);
  event.preventDefault();
  return true;
}

export function clipboardCopyExport(): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      const md = selectionMarkdown(view.state);
      if (md === null) return false; // empty selection: let CM copy the line
      return writeSelection(event, md);
    },
    cut(event, view) {
      const md = selectionMarkdown(view.state);
      if (md === null) return false;
      const handled = writeSelection(event, md);
      // We claimed the event and called preventDefault, so the browser won't
      // delete the selection — do it ourselves through a transaction.
      if (handled) view.dispatch(view.state.replaceSelection(''));
      return handled;
    }
  });
}

// Active document context for an image paste, read from the store at paste
// time so it tracks tab switches without stale closures. Null when no project
// or document is open (nowhere to write the image).
function activeImageContext(): { projectRoot: string; docPath: string } | null {
  const state = useProjectStore.getState();
  const tab = selectActiveTab(state);
  if (!state.manifest || !tab) return null;
  return { projectRoot: state.manifest.root, docPath: tab.path };
}

// First clipboard entry that's a recognised image file, with its extension.
function pickClipboardImage(data: DataTransfer): { file: File; ext: string } | null {
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (!item || item.kind !== 'file') continue;
    const ext = imageExtension(item.type);
    if (!ext) continue;
    const file = item.getAsFile();
    if (file) return { file, ext };
  }
  return null;
}

// base64 payload of a File, via the data URL (handles large files without the
// call-stack limits of String.fromCharCode on a big byte array).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Write a pasted image to the project's assets folder and insert its link.
// Runs after the synchronous paste handler returns: the File reference is
// captured during the event, the rest is async.
async function writePastedImage(view: EditorView, file: File, ext: string): Promise<void> {
  const ctx = activeImageContext();
  if (!ctx) {
    toast.error('Open a document before pasting an image');
    return;
  }
  try {
    const base64 = await fileToBase64(file);
    const { writePath, linkPath } = imagePasteTarget(
      ctx.docPath,
      pastedImageFilename(ext)
    );
    await window.skrive.fs.writeBinaryFile(ctx.projectRoot, writePath, base64);
    view.dispatch({
      ...view.state.replaceSelection(imageMarkdownLink(linkPath)),
      userEvent: 'input.paste',
      scrollIntoView: true
    });
  } catch (err) {
    console.warn('[skrive] image paste failed:', err);
    toast.error('Could not save the pasted image');
  }
}

export function clipboardPasteImport(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data) return false;

      // Rich HTML wins — this also keeps web images as remote ![](url) links
      // rather than copying them into the project.
      const md = markdownForPaste(data.getData('text/html'));
      if (md !== null) {
        view.dispatch({
          ...view.state.replaceSelection(md),
          userEvent: 'input.paste',
          scrollIntoView: true
        });
        event.preventDefault();
        return true;
      }

      // No usable HTML, but a binary image (screenshot, "Copy Image"): claim
      // the event now and write the bytes asynchronously.
      const image = pickClipboardImage(data);
      if (image) {
        event.preventDefault();
        void writePastedImage(view, image.file, image.ext);
        return true;
      }

      // Otherwise let CM's default plain-text paste run.
      return false;
    }
  });
}
