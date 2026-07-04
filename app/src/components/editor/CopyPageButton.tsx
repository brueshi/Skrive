// "Copy page" split button for the editor bar (SKR-126), the export half of the
// clipboard round trip (paste-in is SKR-119). The primary action copies the
// whole document as Markdown (rich dual-write); the chevron opens a menu to copy
// as Markdown or as plain text (Markdown syntax stripped). Lives in the
// right-floated editor-bar controls so it's available in both rendered and source
// views — the single copy affordance for a page (the old floating preview-pane
// copy button was removed in SKR-208).
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
import { IconCopy } from '../icons/IconCopy';
import { IconCheck } from '../icons/IconCheck';
import { IconChevronDown } from './menus/toolbar-icons';
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

export function CopyPageButton() {
  const activeTab = useProjectStore(selectActiveTab);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Hidden when there's no document, or it's empty (nothing to copy).
  if (!activeTab || stripLeadingFrontmatter(activeTab.body).trim() === '') {
    return null;
  }

  function flash() {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  async function copyMarkdown() {
    const body = currentBody();
    if (body === '') return;
    const { text, html } = buildClipboardPayload(body);
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

  async function copyPlainText() {
    const body = currentBody();
    if (body === '') return;
    try {
      await writeTextToClipboard(documentToPlainText(parseDocument(body)));
    } catch (err) {
      console.warn('[skrive] copy page failed:', err);
      return;
    }
    flash();
  }

  return (
    <div className="copy-page">
      <button
        type="button"
        className={`copy-page-main${copied ? ' copied' : ''}`}
        title="Copy page as Markdown"
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
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="copy-page-chevron"
            title="Copy as…"
            aria-label="Copy options"
          >
            <IconChevronDown size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ctx-menu" align="end" sideOffset={6}>
            <DropdownMenu.Item
              className="ctx-item"
              onSelect={() => void copyMarkdown()}
            >
              <span className="ctx-label">Copy as Markdown</span>
            </DropdownMenu.Item>
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
