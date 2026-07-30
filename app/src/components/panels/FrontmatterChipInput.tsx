// Editable chip group for frontmatter array values.
//
// Every chip is a single string element of the array. A trailing input
// sits after the last chip for adding new entries — type, press Enter
// or comma to commit, press Backspace on an empty input to delete the
// previous chip. Clicking a chip's × removes it immediately; clicking
// the chip body itself flips it into an inline edit state with the
// same keyboard rules as the trailing input.
//
// Why a component: the commas-in-values problem. A single text input
// that splits on commas silently mangles `authors: ["Last, First"]` —
// a real and common pattern for author lists, place names, and any
// label with a punctuation pause. One chip per element with an
// explicit commit gesture (Enter or the dedicated comma key) is the
// only edit contract that preserves punctuation.

import { useEffect, useRef, useState } from 'react';
import { Input } from '../ui/Input';

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
  /** Placeholder shown in the trailing input when the array is empty. */
  placeholder?: string;
};

export function FrontmatterChipInput({
  value,
  onChange,
  placeholder = ''
}: Props) {
  const [pendingText, setPendingText] = useState('');
  const [editingIndex, setEditingIndex] = useState(-1);
  const [editingText, setEditingText] = useState('');
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the inline edit input when entering edit mode.
  useEffect(() => {
    if (editingIndex >= 0) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingIndex]);

  function commitPending() {
    const trimmed = pendingText.trim();
    if (trimmed.length === 0) {
      setPendingText('');
      return;
    }
    onChange([...value, trimmed]);
    setPendingText('');
  }

  function handlePendingKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitPending();
    } else if (
      e.key === 'Backspace' &&
      pendingText.length === 0 &&
      value.length > 0
    ) {
      // Backspace on empty input removes the previous chip — how chip
      // editors "feel" correct: deleting backwards walks off the end of
      // the array one chip at a time.
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function removeChip(index: number) {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
    if (editingIndex === index) {
      setEditingIndex(-1);
      setEditingText('');
    } else if (editingIndex > index) {
      setEditingIndex(editingIndex - 1);
    }
  }

  function beginEdit(index: number) {
    setEditingIndex(index);
    setEditingText(value[index] ?? '');
  }

  function commitEdit() {
    if (editingIndex < 0) return;
    const trimmed = editingText.trim();
    if (trimmed.length === 0) {
      removeChip(editingIndex);
      return;
    }
    const next = value.slice();
    next[editingIndex] = trimmed;
    onChange(next);
    setEditingIndex(-1);
    setEditingText('');
  }

  function cancelEdit() {
    setEditingIndex(-1);
    setEditingText('');
  }

  function handleEditKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  return (
    <div className="chip-group" role="list">
      {value.map((chip, i) =>
        editingIndex === i ? (
          <Input
            key={`edit-${i}`}
            ref={editInputRef}
            className="chip-edit"
            type="text"
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            onKeyDown={handleEditKey}
            onBlur={commitEdit}
          />
        ) : (
          <span key={`${i}::${chip}`} className="chip" role="listitem">
            <button
              type="button"
              className="chip-label"
              onClick={() => beginEdit(i)}
              title="Click to edit"
            >
              {chip}
            </button>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${chip}`}
              onClick={() => removeChip(i)}
            >
              ×
            </button>
          </span>
        )
      )}

      <input
        className="chip-pending"
        type="text"
        value={pendingText}
        onChange={(e) => setPendingText(e.target.value)}
        onKeyDown={handlePendingKey}
        onBlur={commitPending}
        placeholder={value.length === 0 ? placeholder : ''}
      />
    </div>
  );
}
