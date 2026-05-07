// Dev-only surface for exercising DiffView during the Phase 5 port.
// Two textareas drive computeLineDiff in real time; the result feeds
// DiffView for visual A/B against v0.1.6. Phase 10 ships HistoryPanel
// proper, at which point this component goes away.

import { useEffect, useMemo, useState } from 'react';
import { DiffView, type DiffMode } from './DiffView';
import { computeLineDiff } from '../../lib/diff/line-diff';
import type { LineDiffRow } from '../../lib/diff/line-diff';

type Preset = 'reword' | 'reorder' | 'insert' | 'blank';

const PRESETS: Record<Preset, { before: string; after: string }> = {
  reword: {
    before: `# Daily notes

Coffee, then a quick sweep of overnight email.

The morning's main task is finishing the spec for the new
storage layer.

After lunch I'll review the team's PRs.

Wrap up with a 30-minute walk and journaling.
`,
    after: `# Daily notes

Coffee, then a quick sweep of overnight email.

The morning is reserved for finishing the spec for the new
storage layer; this is the deep-work block.

After lunch I'll review the team's PRs.

Wrap up with a 30-minute walk and journaling.
`
  },
  reorder: {
    before: `# Section A

Paragraph A1.

Paragraph A2.

# Section B

Paragraph B1.

Paragraph B2.
`,
    after: `# Section B

Paragraph B1.

Paragraph B2.

# Section A

Paragraph A1.

Paragraph A2.
`
  },
  insert: {
    before: `# Intro

Setup paragraph.

# Conclusion

Closing thoughts.
`,
    after: `# Intro

Setup paragraph.

# New section

A paragraph that didn't exist before.

# Conclusion

Closing thoughts.
`
  },
  blank: { before: '', after: '' }
};

type Props = {
  onClose: () => void;
};

export function DiffPlayground({ onClose }: Props) {
  const [preset, setPreset] = useState<Preset>('reword');
  const [before, setBefore] = useState(PRESETS.reword.before);
  const [after, setAfter] = useState(PRESETS.reword.after);
  const [rows, setRows] = useState<LineDiffRow[]>([]);
  const [mode, setMode] = useState<DiffMode>('diff-raw');
  const [dividerRatio, setDividerRatio] = useState(0.5);

  // Debounced diff recompute. 150ms is short enough to feel live and
  // long enough that holding a key in the textarea doesn't rebuild
  // the diff between every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void computeLineDiff(before, after).then(setRows);
    }, 150);
    return () => clearTimeout(timer);
  }, [before, after]);

  function applyPreset(next: Preset) {
    setPreset(next);
    setBefore(PRESETS[next].before);
    setAfter(PRESETS[next].after);
  }

  const sides = useMemo(
    () => ({
      before: { label: 'before.md', timestampMs: Date.now() - 5 * 60_000 },
      after: { label: 'after.md', timestampMs: Date.now() }
    }),
    []
  );

  return (
    <div className="diff-playground">
      <div className="diff-playground-toolbar">
        <span>Diff playground</span>
        <select
          value={preset}
          onChange={(e) => applyPreset(e.target.value as Preset)}
        >
          <option value="reword">reword</option>
          <option value="reorder">reorder</option>
          <option value="insert">insert</option>
          <option value="blank">blank</option>
        </select>
        <span style={{ marginLeft: 'auto' }}>⌘⇧D to toggle · Esc to close</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="diff-playground-inputs">
        <textarea
          value={before}
          onChange={(e) => setBefore(e.target.value)}
          placeholder="before…"
          spellCheck={false}
        />
        <textarea
          value={after}
          onChange={(e) => setAfter(e.target.value)}
          placeholder="after…"
          spellCheck={false}
        />
      </div>
      <div className="diff-playground-output">
        <DiffView
          mode={mode}
          before={sides.before}
          after={sides.after}
          dividerRatio={dividerRatio}
          rows={rows}
          onModeChange={setMode}
          onDividerChange={setDividerRatio}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
