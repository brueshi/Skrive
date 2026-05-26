// CodeMirror clipboard wiring. Thin by design: it reads the selection, hands
// off to the pure copy-out logic in `lib/clipboard`, and writes the result to
// the DOM clipboard event. No conversion logic lives here.
//
// Scope (Stage 1): copy and cut from the editor surface. Paste-in (Stage 2)
// and the read-only preview pane are handled elsewhere.

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { buildClipboardPayload, selectionMarkdown } from '../../lib/clipboard/copyOut';

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
