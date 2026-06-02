// Floating frontmatter editor for the active tab.
//
// The panel is an *orthogonal tool*, not pinned chrome — invoked via
// the FM·N indicator in the header or ⌘⇧F, and dismissed via Escape,
// a click outside, or the same toggle. When closed, the only visible
// cost is the header indicator; when open, the panel floats in the
// top-right of the workspace with no impact on the editor surface's
// available vertical space.
//
// Per-type rendering:
//   - string, number, null, new fields  → plain text input
//   - boolean                           → text input, coerces "true"/"false"
//                                          back to bool on commit
//   - array                             → FrontmatterChipInput
//   - object                            → read-only `<object>` placeholder
//
// Commit contract: on blur or Enter, each input re-parses the current
// text using the *original value type as a hint* so typing `false` into
// a boolean field stays a boolean rather than silently becoming a string.
// New fields default to string because there's no way to disambiguate
// intent from text alone.
//
// Key rename conflict: the store's renameActiveTabFrontmatterKey silently
// no-ops when the target key already exists. The panel re-reads the map
// after the rename attempt, so a no-op naturally shows the old key in
// the UI with no modal needed.

import { useEffect, useRef, useState } from 'react';
import {
  selectActiveTab,
  useProjectStore
} from '../../stores/project';
import {
  coerceToOriginalType,
  stringifyValue,
  valueTypeOf,
  type FieldInfo
} from '../../lib/frontmatter';
import { FrontmatterChipInput } from './FrontmatterChipInput';
import { PanelShell } from './PanelShell';
import { SuggestionList } from './SuggestionList';

type Row = { id: string; key: string };

type SuggestionKind = 'key' | 'value';

type ActiveSuggestion = {
  rowId: string;
  kind: SuggestionKind;
  suggestions: string[];
  selectedIndex: number;
};

const SUGGESTION_LIMIT = 8;

function lowerStartsWith(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  return haystack.toLowerCase().startsWith(needle.toLowerCase());
}

export function FrontmatterPanel() {
  const open = useProjectStore((s) => s.frontmatterPanelOpen);
  const close = useProjectStore((s) => s.closeFrontmatterPanel);
  const activeTab = useProjectStore(selectActiveTab);
  const manifest = useProjectStore((s) => s.manifest);
  const updateField = useProjectStore((s) => s.updateActiveTabFrontmatter);
  const removeField = useProjectStore((s) => s.removeActiveTabFrontmatter);
  const renameKey = useProjectStore((s) => s.renameActiveTabFrontmatterKey);

  const panelRef = useRef<HTMLDivElement | null>(null);

  const activeFrontmatter = activeTab?.frontmatter ?? {};
  const schema = manifest?.schema ?? null;

  // ===== Stable row IDs =====
  //
  // The panel maintains its own row list with stable per-row IDs, rather
  // than iterating Object.keys(frontmatter) directly. Renames on the
  // store are delete-old + insert-new under a different name; if the
  // map were keyed on the field's name in the React render, the row's
  // input would unmount/remount mid-edit and tear down focus. With
  // stable row IDs the DOM element is reused and Tab navigates naturally.

  const [rows, setRows] = useState<Row[]>([]);
  const nextRowIdRef = useRef(0);
  const lastSyncedPathRef = useRef<string | null>(null);

  function makeRow(key: string): Row {
    const id = String(nextRowIdRef.current++);
    return { id, key };
  }

  useEffect(() => {
    const path = activeTab?.path ?? null;
    const currentKeys = Object.keys(activeFrontmatter);

    if (path !== lastSyncedPathRef.current) {
      lastSyncedPathRef.current = path;
      setRows(currentKeys.map(makeRow));
      return;
    }
    setRows((prev) => {
      const currentKeySet = new Set(currentKeys);
      const knownKeys = new Set(prev.map((r) => r.key));
      const kept = prev.filter((r) => currentKeySet.has(r.key));
      const added = currentKeys
        .filter((k) => !knownKeys.has(k))
        .map(makeRow);
      if (kept.length === prev.length && added.length === 0) return prev;
      return [...kept, ...added];
    });
    // We deliberately depend on the identity of activeFrontmatter so the
    // effect fires when auto-stamped values change, but we read keys via
    // the map snapshot above.
  }, [activeTab?.path, activeFrontmatter]);

  // ===== Autocomplete state =====

  const [activeSuggestion, setActiveSuggestion] =
    useState<ActiveSuggestion | null>(null);

  function computeKeyCandidates(row: Row, prefix: string): string[] {
    if (!schema) return [];
    const usedKeys = new Set(rows.map((r) => r.key));
    const candidates: { name: string; presence: number }[] = [];
    for (const [name, info] of Object.entries(schema.fields)) {
      if (usedKeys.has(name) && name !== row.key) continue;
      if (!lowerStartsWith(name, prefix)) continue;
      candidates.push({ name, presence: info.presence });
    }
    candidates.sort((a, b) => {
      const diff = b.presence - a.presence;
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
    return candidates.slice(0, SUGGESTION_LIMIT).map((c) => c.name);
  }

  function computeValueCandidates(row: Row, prefix: string): string[] {
    if (!schema) return [];
    const info: FieldInfo | undefined = schema.fields[row.key];
    if (!info || info.knownValues.length === 0) return [];
    const out: string[] = [];
    for (const v of info.knownValues) {
      if (
        v !== null &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        continue;
      }
      const display = v === null ? '' : String(v);
      if (!lowerStartsWith(display, prefix)) continue;
      out.push(display);
      if (out.length >= SUGGESTION_LIMIT) break;
    }
    return out;
  }

  function openKeySuggestions(row: Row, currentText: string) {
    const suggestions = computeKeyCandidates(row, currentText);
    if (suggestions.length === 0) {
      setActiveSuggestion(null);
      return;
    }
    setActiveSuggestion({
      rowId: row.id,
      kind: 'key',
      suggestions,
      selectedIndex: 0
    });
  }

  function openValueSuggestions(row: Row, currentText: string) {
    const suggestions = computeValueCandidates(row, currentText);
    if (suggestions.length === 0) {
      setActiveSuggestion(null);
      return;
    }
    setActiveSuggestion({
      rowId: row.id,
      kind: 'value',
      suggestions,
      selectedIndex: 0
    });
  }

  function dismissSuggestions() {
    setActiveSuggestion(null);
  }

  function navigateSuggestion(delta: number) {
    setActiveSuggestion((cur) => {
      if (!cur) return cur;
      const max = cur.suggestions.length - 1;
      let next = cur.selectedIndex + delta;
      if (next < 0) next = max;
      if (next > max) next = 0;
      return { ...cur, selectedIndex: next };
    });
  }

  function highlightSuggestion(index: number) {
    setActiveSuggestion((cur) => {
      if (!cur) return cur;
      return { ...cur, selectedIndex: index };
    });
  }

  function suggestionActiveFor(rowId: string, kind: SuggestionKind): boolean {
    return (
      activeSuggestion?.rowId === rowId && activeSuggestion?.kind === kind
    );
  }

  // ===== Mutation actions =====

  function commitValue(row: Row, nextText: string, originalType: string) {
    const coerced = coerceToOriginalType(nextText, originalType);
    updateField(row.key, coerced);
  }

  function commitArrayValue(row: Row, nextArray: string[]) {
    updateField(row.key, nextArray);
  }

  function discardRow(row: Row) {
    removeField(row.key);
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  function commitKey(
    row: Row,
    newKey: string,
    inputEl: HTMLInputElement
  ) {
    const trimmed = newKey.trim();
    if (trimmed === row.key) return;
    if (trimmed.length === 0) {
      discardRow(row);
      return;
    }
    const conflict = rows.some((r) => r.id !== row.id && r.key === trimmed);
    if (conflict) {
      // Revert — force the input back to the previous key. No modal,
      // no error: the plan's explicit "silently revert on conflict" rule.
      inputEl.value = row.key;
      return;
    }
    renameKey(row.key, trimmed);
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, key: trimmed } : r))
    );
  }

  function pickSuggestion(
    row: Row,
    pickedValue: string,
    inputEl: HTMLInputElement
  ) {
    if (!activeSuggestion) return;
    const kind = activeSuggestion.kind;
    inputEl.value = pickedValue;
    if (kind === 'key') {
      commitKey(row, pickedValue, inputEl);
      dismissSuggestions();
      const rowEl = inputEl.closest('.fm-row');
      const valueInput = rowEl?.querySelector<HTMLElement>(
        '.value-input, .chip-pending'
      );
      valueInput?.focus();
    } else {
      const currentValue = activeFrontmatter[row.key];
      const type = valueTypeOf(currentValue);
      commitValue(row, pickedValue, type);
      dismissSuggestions();
    }
  }

  function handleSuggestionKeydown(
    e: React.KeyboardEvent<HTMLInputElement>,
    row: Row,
    kind: SuggestionKind
  ): boolean {
    if (!suggestionActiveFor(row.id, kind)) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateSuggestion(1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateSuggestion(-1);
      return true;
    }
    if (e.key === 'Escape') {
      // Stop propagation so the panel root's Escape handler doesn't also
      // close the panel — Escape with a dropdown open should dismiss the
      // dropdown only, leaving the panel and the user's focus intact.
      e.preventDefault();
      e.stopPropagation();
      dismissSuggestions();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const cur = activeSuggestion;
      const picked = cur ? cur.suggestions[cur.selectedIndex] ?? null : null;
      if (picked !== null) {
        e.preventDefault();
        pickSuggestion(row, picked, e.currentTarget);
        return true;
      }
    }
    return false;
  }

  function addNewField() {
    if (!activeTab) return;
    let base = 'new_field';
    let candidate = base;
    let i = 2;
    while (
      rows.some((r) => r.key === candidate) ||
      candidate in activeFrontmatter
    ) {
      candidate = `${base}_${i}`;
      i += 1;
    }
    updateField(candidate, '');
    const row = makeRow(candidate);
    setRows((prev) => [...prev, row]);
    queueMicrotask(() => {
      const input = panelRef.current?.querySelector<HTMLInputElement>(
        `[data-row-id="${row.id}"] .key-input`
      );
      input?.focus();
      input?.select();
    });
  }

  // ===== Dismiss handling =====

  function handleRootKeydown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  // Docked panels stay put on outside clicks so you can keep editing
  // alongside them; Escape (handleRootKeydown) and the toggle dismiss.

  const activePathLabel = activeTab?.path ?? '';

  return (
    <PanelShell
      open={open}
      ariaLabel="Frontmatter editor"
      panelRef={panelRef}
      className="fm-panel"
      widthRem={32}
    >
      <div onKeyDown={handleRootKeydown}>
        <header className="fm-panel-header">
          <span className="fm-panel-title">Frontmatter</span>
          <span className="fm-panel-path" title={activePathLabel}>
            {activePathLabel}
          </span>
          <span className="fm-panel-count">{rows.length}</span>
        </header>

        <div className="fm-panel-body">
          {rows.length === 0 && (
            <p className="fm-empty">
              No frontmatter yet. Add a field to start structured metadata
              for this file.
            </p>
          )}

          {rows.map((row) => {
            const value = activeFrontmatter[row.key];
            const type = valueTypeOf(value);
            return (
              <div key={row.id} className="fm-row" data-row-id={row.id}>
                <div className="input-with-suggestions">
                  <input
                    className="key-input"
                    type="text"
                    defaultValue={row.key}
                    aria-label="Field key"
                    aria-autocomplete="list"
                    onFocus={(e) =>
                      openKeySuggestions(row, e.currentTarget.value)
                    }
                    onInput={(e) =>
                      openKeySuggestions(
                        row,
                        (e.currentTarget as HTMLInputElement).value
                      )
                    }
                    onBlur={(e) => {
                      dismissSuggestions();
                      commitKey(row, e.currentTarget.value, e.currentTarget);
                    }}
                    onKeyDown={(e) => {
                      if (handleSuggestionKeydown(e, row, 'key')) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const rowEl = e.currentTarget.closest('.fm-row');
                        const valueInput = rowEl?.querySelector<HTMLElement>(
                          '.value-input, .chip-pending'
                        );
                        e.currentTarget.blur();
                        valueInput?.focus();
                      }
                    }}
                  />
                  {suggestionActiveFor(row.id, 'key') && activeSuggestion && (
                    <SuggestionList
                      suggestions={activeSuggestion.suggestions}
                      selectedIndex={activeSuggestion.selectedIndex}
                      onPick={(picked) => {
                        const input =
                          panelRef.current?.querySelector<HTMLInputElement>(
                            `[data-row-id="${row.id}"] .key-input`
                          );
                        if (input) pickSuggestion(row, picked, input);
                      }}
                      onHover={highlightSuggestion}
                    />
                  )}
                </div>

                <div className="value-slot">
                  {type === 'array' ? (
                    <FrontmatterChipInput
                      value={(value as unknown[]).map((v) => String(v))}
                      onChange={(next) => commitArrayValue(row, next)}
                    />
                  ) : type === 'object' ? (
                    <span
                      className="value-object"
                      title="Nested object — edit via file"
                    >
                      &lt;object&gt;
                    </span>
                  ) : (
                    <div className="input-with-suggestions">
                      <input
                        className="value-input"
                        type="text"
                        // The defaultValue + onBlur commit pattern matches
                        // the key input. Using `value` here would force a
                        // controlled component and lose the conflict-revert
                        // trick (imperatively setting input.value on blur).
                        defaultValue={stringifyValue(value)}
                        // Re-key when the underlying value changes (auto-
                        // stamped fields, external rewrites) so the
                        // displayed text resyncs.
                        key={`${row.id}:${stringifyValue(value)}`}
                        aria-label="Field value"
                        aria-autocomplete="list"
                        onFocus={(e) =>
                          openValueSuggestions(row, e.currentTarget.value)
                        }
                        onInput={(e) =>
                          openValueSuggestions(
                            row,
                            (e.currentTarget as HTMLInputElement).value
                          )
                        }
                        onBlur={(e) => {
                          dismissSuggestions();
                          commitValue(row, e.currentTarget.value, type);
                        }}
                        onKeyDown={(e) => {
                          if (handleSuggestionKeydown(e, row, 'value')) return;
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }
                        }}
                      />
                      {suggestionActiveFor(row.id, 'value') &&
                        activeSuggestion && (
                          <SuggestionList
                            suggestions={activeSuggestion.suggestions}
                            selectedIndex={activeSuggestion.selectedIndex}
                            onPick={(picked) => {
                              const input =
                                panelRef.current?.querySelector<HTMLInputElement>(
                                  `[data-row-id="${row.id}"] .value-input`
                                );
                              if (input) pickSuggestion(row, picked, input);
                            }}
                            onHover={highlightSuggestion}
                          />
                        )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="remove-button"
                  aria-label={`Remove ${row.key}`}
                  title="Remove field"
                  onClick={() => discardRow(row)}
                >
                  ×
                </button>
              </div>
            );
          })}

          <button
            type="button"
            className="add-button"
            onClick={addNewField}
            disabled={!activeTab}
          >
            + Add field
          </button>
        </div>
      </div>
    </PanelShell>
  );
}
