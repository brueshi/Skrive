// Markdown-mode adapter over the model-in/model-out BlockEditor (SKR-196).
//
// Markdown files edit through the block model as an interim (the dual-mode ADR:
// `.md` keeps the rendered surface until source mode ships in SKR-197). This
// adapter is the one place that parses `.md` bytes into the model and serializes
// the model back — keeping that concern out of BlockEditor, which is now purely
// model-canonical so `.folio` rich mode can mount it directly.
//
// Load-bearing boundary: serializing here refreshes the tab's in-memory `body`
// buffer during editing. It is NOT the save path — the save writes that text
// buffer verbatim (see stores/save). The serializer must never move into a save
// function; that is the trap the split exists to close.
//
// Uncontrolled, mirroring BlockEditor: the body is parsed once on mount (App keys
// the mount by path, so a file switch remounts and re-parses the current bytes).

import { useState } from 'react';
import { parseDocument, serializeDocument } from '../../../lib/blockmodel';
import { BlockEditor } from './BlockEditor';

type Props = {
  /** Canonical Markdown body. Parsed once on mount; uncontrolled thereafter. */
  body: string;
  /** Receives the re-serialized Markdown body on each debounced snapshot. */
  onChange: (next: string) => void;
};

export function MarkdownBlockEditor({ body, onChange }: Props): React.ReactElement {
  // Lazy initializer: parse exactly once per mount, matching the surface's
  // uncontrolled lifetime. Re-parsing on every render (App re-renders on each
  // debounced setTabBody) would be wasted work the surface ignores.
  const [initialDoc] = useState(() => parseDocument(body));
  return <BlockEditor doc={initialDoc} onChange={(doc) => onChange(serializeDocument(doc))} />;
}
