// "Copy page" split button for the editor bar (SKR-126), the export half of the
// clipboard round trip (paste-in is SKR-119). The primary action copies the
// whole document as Markdown (rich dual-write); the chevron opens a menu of
// copy-as formats. Lives in the right-floated editor-bar controls — the single
// copy affordance for a page (the old floating preview-pane copy button was
// removed in SKR-208).
//
// Mode-aware (SKR-226): a Markdown tab copies its text body; a rich `.folio`
// tab projects its block model through the SKR-199 export pipeline, so what
// lands on the clipboard is exactly the export output. The rich menu adds
// "Copy as HTML" (the full export document, as source).
//
// Reads the document from the project store (works across views, unlike the
// surface which only exists in rendered mode), flushing any pending debounced
// snapshot first so the copy reflects the latest edits.

import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { selectActiveTab, useProjectStore } from '../../stores/project';
import { flushActiveEditor } from './active-editor';
import { stripLeadingFrontmatter } from '../../lib/preview/markdown';
import { parseDocument, documentToPlainText } from '../../lib/blockmodel';
import { buildClipboardPayload } from '../../lib/clipboard/copyOut';
import {
  writeRichToClipboard,
  writeTextToClipboard
} from '../../lib/clipboard/systemClipboard';
import { modelToFolio, type FolioDocument } from '../../lib/folio';
import {
  folioToMarkdown,
  folioToHtml,
  folioToPlainText
} from '../../lib/export';
import { stripFolioExtension } from '../../lib/title';
import { IconCopy } from '../icons/IconCopy';
import { IconCheck } from '../icons/IconCheck';
import { IconChevronDown } from './menus/toolbar-icons';
import { Tooltip } from '../ui/Tooltip';
import './CopyPageButton.css';

const COPIED_FEEDBACK_MS = 1600;

// Flush a pending snapshot, then read the freshest body from the store (the
// component's own subscription would be a render behind the flush). Frontmatter
// is stripped to match what the document shows.
function currentBody(): string {
  flushActiveEditor();
  const tab = selectActiveTab(useProjectStore.getState());
  return tab ? stripLeadingFrontmatter(tab.body).trim() : '';
}

// The rich-tab analogue: flush, then project the live block model to a
// FolioDocument for the export pipeline. Null when the active tab isn't a
// fully-loaded rich document.
function currentFolio(): { folio: FolioDocument; title: string } | null {
  flushActiveEditor();
  const tab = selectActiveTab(useProjectStore.getState());
  if (!tab || tab.mode !== 'rich' || !tab.model || !tab.docId || !tab.docMeta) {
    return null;
  }
  return {
    folio: modelToFolio(tab.model, { docId: tab.docId, docMeta: tab.docMeta }),
    title: stripFolioExtension(tab.path.split('/').pop() ?? tab.path)
  };
}

export function CopyPageButton() {
  const activeTab = useProjectStore(selectActiveTab);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const isRich = activeTab?.mode === 'rich';

  // Hidden when there's no document, it's empty (nothing to copy), or it's a
  // read-only viewer (`view`, SKR-205) — its body is raw HTML, and copying that
  // through the Markdown clipboard path would emit garbage. Its own EditorBar is
  // skipped too, so this is a belt-and-suspenders guard against other mount sites.
  // A rich tab shows once its model is loaded; emptiness is guarded in the copy
  // handlers instead (serializing the model on every render to test it would be
  // wasted work).
  if (!activeTab || activeTab.mode === 'view') return null;
  if (isRich) {
    if (!activeTab.model) return null;
  } else if (stripLeadingFrontmatter(activeTab.body).trim() === '') {
    return null;
  }

  function flash() {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  // The document's Markdown, whatever the tab mode: the text body for `.md`,
  // the SKR-199 export projection for `.folio`.
  function currentMarkdown(): string {
    if (!isRich) return currentBody();
    const rich = currentFolio();
    return rich ? folioToMarkdown(rich.folio).trim() : '';
  }

  async function copyMarkdown() {
    const md = currentMarkdown();
    if (md === '') return;
    const { text, html } = buildClipboardPayload(md);
    try {
      await writeRichToClipboard(html, text);
    } catch {
      try {
        await writeTextToClipboard(text);
      } catch (err) {
        console.warn('[skrive] copy page failed:', err);
        return;
      }
    }
    flash();
  }

  // Rich only: the full SKR-199 HTML export document, copied as source.
  async function copyHtml() {
    const rich = currentFolio();
    if (!rich || folioToMarkdown(rich.folio).trim() === '') return;
    try {
      await writeTextToClipboard(folioToHtml(rich.folio, { title: rich.title }));
    } catch (err) {
      console.warn('[skrive] copy page failed:', err);
      return;
    }
    flash();
  }

  async function copyPlainText() {
    let text: string;
    if (isRich) {
      const rich = currentFolio();
      text = rich ? folioToPlainText(rich.folio).trim() : '';
    } else {
      const body = currentBody();
      text = body === '' ? '' : documentToPlainText(parseDocument(body));
    }
    if (text === '') return;
    try {
      await writeTextToClipboard(text);
    } catch (err) {
      console.warn('[skrive] copy page failed:', err);
      return;
    }
    flash();
  }

  return (
    <div className="copy-page">
      <Tooltip label="Copy page as Markdown">
        <button
          type="button"
          className={`copy-page-main${copied ? ' copied' : ''}`}
          onClick={() => void copyMarkdown()}
        >
          {/* Copy and check glyphs stacked and crossfaded, matching the preview
              copy affordance so the feedback reads consistently across surfaces. */}
          <span className="copy-page-glyphs">
            <IconCopy size={16} className="copy-page-glyph is-copy" />
            <IconCheck size={16} className="copy-page-glyph is-check" />
          </span>
          <span className="copy-page-label">Copy page</span>
        </button>
      </Tooltip>
      <DropdownMenu.Root>
        <Tooltip label="Copy as…">
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="copy-page-chevron"
              aria-label="Copy options"
            >
              <IconChevronDown size={14} />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ctx-menu" align="end" sideOffset={6}>
            <DropdownMenu.Item
              className="ctx-item"
              onSelect={() => void copyMarkdown()}
            >
              <span className="ctx-label">Copy as Markdown</span>
            </DropdownMenu.Item>
            {isRich && (
              <DropdownMenu.Item
                className="ctx-item"
                onSelect={() => void copyHtml()}
              >
                <span className="ctx-label">Copy as HTML</span>
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="ctx-item"
              onSelect={() => void copyPlainText()}
            >
              <span className="ctx-label">Copy as plain text</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
