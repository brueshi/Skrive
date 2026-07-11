// The front-title + summon fan (SKR-243, planning/chrome-navigation-model.md).
//
// The centered document name in the band tabs vacated — the macOS document
// convention. Single-job: clicking it (anywhere on the title) summons the
// fan; rename stays F2 / the context menu. A chevron fades in on hover to
// say "I open".
//
// The fan is the *pointer* path over the working set: an anchored panel of
// the same array the ⌘P switcher's empty state reads, most recent first,
// the live doc as a marked, non-switchable current row. Keyboard users are
// expected to live in ⌘P — no hotkey opens the fan. Radix DropdownMenu
// supplies ↑/↓/Enter, Esc, click-away, and the portal; activation rides its
// click-driven selection (never a bare pointerup — the WKWebView
// motionless-press gotcha).

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { useProjectStore, logProjectError } from '../../stores/project';
import { focusEditorSoon, getActiveBlockMenu } from '../editor/active-surface';
import { DocIcon } from '../icons/DocIcon';
import { middleTruncate, stripFolioExtension } from '../../lib/title';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import { noDragProps } from './windowDrag';

type Props = {
  /** Opens the ⌘P switcher (the fan's "All files…" footer). Owned by App —
   *  the switcher modal lives there. */
  onOpenSwitcher: () => void;
};

function leafName(p: string): string {
  const i = p.lastIndexOf('/');
  return stripFolioExtension(i === -1 ? p : p.slice(i + 1));
}

/** The dimmed parent-folder hint on a fan row ("Manuscript", not the full
 *  path). Empty for root-level documents. */
function parentName(p: string): string {
  const i = p.lastIndexOf('/');
  if (i === -1) return '';
  const dir = p.slice(0, i);
  const j = dir.lastIndexOf('/');
  return j === -1 ? dir : dir.slice(j + 1);
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function FrontTitle({ onOpenSwitcher }: Props) {
  const manifest = useProjectStore((s) => s.manifest);
  const liveDoc = useProjectStore((s) => s.liveDoc);
  const workingSet = useProjectStore((s) => s.workingSet);
  const openDoc = useProjectStore((s) => s.openDoc);
  const [open, setOpen] = useState(false);

  if (!manifest) return null;

  // No document open: the project name, dimmed, with the keyboard path as
  // the affordance. Not a trigger — there is no working set to fan.
  if (!liveDoc) {
    const projectName =
      manifest.config.project.name ?? basename(manifest.root);
    return (
      <div className="front-title-slot">
        <span className="front-title-empty">
          <span className="front-title-empty-name">{projectName}</span>
          <span className="front-title-empty-hint">
            Open a document {platformShortcut('⌘P')}
          </span>
        </span>
      </div>
    );
  }

  function handleSelect(path: string) {
    void openDoc(path)
      .then(() => focusEditorSoon())
      .catch((err) => logProjectError('openDoc (fan)', err));
  }

  return (
    <div className="front-title-slot">
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="front-title"
            title={liveDoc.path}
            {...noDragProps}
          >
            <span className="front-title-name">
              {middleTruncate(leafName(liveDoc.path))}
            </span>
            <svg
              className="front-title-chev"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 3.5 L5 6.5 L8 3.5" />
            </svg>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="fan"
            align="center"
            sideOffset={6}
            // The editor should own the caret when the fan closes, not the
            // title button Radix would restore focus to. On a plain dismiss
            // the mounted surface refocuses here; after a switch the new
            // surface mounts a frame later (focusEditorSoon in the select
            // handler covers it).
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              getActiveBlockMenu()?.focusEditor();
            }}
          >
            {workingSet.map((entry, i) => {
              const current = entry.path === liveDoc.path;
              return (
                <DropdownMenu.Item
                  key={entry.path}
                  className={`fan-row${current ? ' current' : ''}`}
                  style={{ '--fan-i': i } as React.CSSProperties}
                  disabled={current}
                  onSelect={() => handleSelect(entry.path)}
                >
                  <span className="fan-glyph" aria-hidden="true">
                    <DocIcon path={entry.path} size={16} />
                  </span>
                  <span className="fan-name">{leafName(entry.path)}</span>
                  <span className="fan-where">{parentName(entry.path)}</span>
                </DropdownMenu.Item>
              );
            })}
            <DropdownMenu.Separator className="fan-sep" />
            <DropdownMenu.Item
              className="fan-row fan-foot"
              style={{ '--fan-i': workingSet.length } as React.CSSProperties}
              onSelect={() => onOpenSwitcher()}
            >
              <span className="fan-name">All files…</span>
              <span className="fan-where">{platformShortcut('⌘P')}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
