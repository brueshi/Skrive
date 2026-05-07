// Settings modal. Built on Radix Dialog (focus trap, ESC, scroll lock).
// Phase 9 sections: General, Editor, Personal dictionary, Updates,
// About. Saves are debounced through the preferences store; this
// component just dispatches actions on every change.
//
// The Updates section's "Check for updates…" button is rendered but
// inert — `electron-updater` wiring is post-Phase 9 (release-pipeline
// follow-up). The toggle state still persists.

import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import type { EditorFontId } from '@skrive/shared';
import { usePreferencesStore } from '../../stores/preferences';
import {
  EDITOR_FONT_PRESETS,
  FONT_SIZE_STEPS,
  LINE_HEIGHT_STEPS_X100,
  lineHeightLabel
} from '../../lib/typography';
import { notify } from '../../lib/notify';

type SectionId = 'general' | 'editor' | 'dictionary' | 'updates' | 'about';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'editor', label: 'Editor' },
  { id: 'dictionary', label: 'Personal dictionary' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' }
];

const APP_LICENSE_LABEL = 'PolyForm Noncommercial 1.0.0';

type Props = {
  open: boolean;
  appVersion: string;
  onClose: () => void;
};

export function SettingsModal({ open, appVersion, onClose }: Props) {
  const [section, setSection] = useState<SectionId>('general');

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal-dialog settings-dialog"
          aria-describedby={undefined}
        >
          <Dialog.Title className="settings-title">Settings</Dialog.Title>
          <div className="settings-shell">
            <nav className="settings-nav" aria-label="Settings sections">
              <ul className="settings-nav-list">
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`settings-nav-item${
                        section === s.id ? ' active' : ''
                      }`}
                      onClick={() => setSection(s.id)}
                      aria-current={section === s.id ? 'page' : undefined}
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="settings-pane">
              {section === 'general' && <GeneralSection />}
              {section === 'editor' && <EditorSection />}
              {section === 'dictionary' && <DictionarySection />}
              {section === 'updates' && (
                <UpdatesSection appVersion={appVersion} />
              )}
              {section === 'about' && (
                <AboutSection appVersion={appVersion} />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SectionHeader({
  title,
  blurb
}: {
  title: string;
  blurb: string;
}) {
  return (
    <header className="settings-pane-header">
      <h2>{title}</h2>
      <p className="settings-pane-blurb">{blurb}</p>
    </header>
  );
}

function GeneralSection() {
  const skipDelete = usePreferencesStore((s) => s.skipDeleteConfirmation);
  const setSkip = usePreferencesStore((s) => s.setSkipDeleteConfirmation);
  return (
    <>
      <SectionHeader
        title="General"
        blurb="App-wide behavior. These settings apply across every project you open."
      />
      <div className="settings-group">
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={skipDelete}
            onChange={(e) => setSkip(e.target.checked)}
          />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">
              Skip delete confirmation
            </span>
            <span className="settings-toggle-desc">
              Move files and folders straight to trash without the confirmation
              modal. Trash is reversible from Finder/Explorer.
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

function EditorSection() {
  const editorFont = usePreferencesStore((s) => s.editorFont);
  const customFamily = usePreferencesStore((s) => s.editorCustomFontFamily);
  const fontSize = usePreferencesStore((s) => s.editorFontSize);
  const lineHeight = usePreferencesStore((s) => s.editorLineHeightX100);
  const setEditorFont = usePreferencesStore((s) => s.setEditorFont);
  const setCustom = usePreferencesStore((s) => s.setEditorCustomFontFamily);
  const setSize = usePreferencesStore((s) => s.setEditorFontSize);
  const setLine = usePreferencesStore((s) => s.setEditorLineHeightX100);
  const reset = usePreferencesStore((s) => s.resetEditorDefaults);

  return (
    <>
      <SectionHeader
        title="Editor"
        blurb="Typography. The Custom field is the 80%-of-the-value alternative to a font installer — the editor falls back gracefully when the font isn't on the system."
      />

      <div className="settings-group">
        <label className="settings-label">Font</label>
        <div className="settings-font-grid">
          {EDITOR_FONT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`settings-font-tile${
                editorFont === preset.id ? ' active' : ''
              }`}
              onClick={() => setEditorFont(preset.id)}
              aria-pressed={editorFont === preset.id}
              style={{ fontFamily: preset.stack }}
            >
              <span className="settings-font-tile-label">{preset.label}</span>
              <span className="settings-font-tile-subtext">{preset.subtext}</span>
            </button>
          ))}
        </div>
        {editorFont === 'custom' && (
          <input
            type="text"
            className="settings-input"
            placeholder="Family name (e.g. Inter, Iowan Old Style)"
            value={customFamily}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Custom font family"
          />
        )}
      </div>

      <div className="settings-group">
        <label className="settings-label">Size</label>
        <div className="settings-stepper">
          {FONT_SIZE_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={`settings-stepper-button${
                fontSize === step ? ' active' : ''
              }`}
              onClick={() => setSize(step)}
              aria-pressed={fontSize === step}
            >
              {step}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Line height</label>
        <div className="settings-stepper">
          {LINE_HEIGHT_STEPS_X100.map((step) => (
            <button
              key={step}
              type="button"
              className={`settings-stepper-button${
                lineHeight === step ? ' active' : ''
              }`}
              onClick={() => setLine(step)}
              aria-pressed={lineHeight === step}
            >
              {lineHeightLabel(step)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <button
          type="button"
          className="settings-secondary-button"
          onClick={reset}
        >
          Reset editor defaults
        </button>
      </div>
    </>
  );
}

function DictionarySection() {
  const words = usePreferencesStore((s) => s.personalDictionary);
  const add = usePreferencesStore((s) => s.addDictionaryWord);
  const remove = usePreferencesStore((s) => s.removeDictionaryWord);
  const [pending, setPending] = useState('');

  const sorted = [...words].sort((a, b) =>
    a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())
  );

  function commit() {
    add(pending);
    setPending('');
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    }
  }

  return (
    <>
      <SectionHeader
        title="Personal dictionary"
        blurb="Words on this list are layered on top of the OS spellchecker. Project-scoped words live in .skrive.toml under [dictionary].project_words."
      />
      <div className="settings-group">
        <div className="settings-dict-input">
          <input
            type="text"
            className="settings-input"
            placeholder="Add a word…"
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={onKey}
            aria-label="Add a word to the personal dictionary"
          />
          <button
            type="button"
            className="settings-secondary-button"
            onClick={commit}
            disabled={pending.trim().length === 0}
          >
            Add
          </button>
        </div>
        {sorted.length === 0 ? (
          <p className="settings-empty">No words yet.</p>
        ) : (
          <ul className="settings-dict-list">
            {sorted.map((word) => (
              <li key={word} className="settings-dict-row">
                <span className="settings-dict-word">{word}</span>
                <button
                  type="button"
                  className="settings-dict-remove"
                  onClick={() => remove(word)}
                  aria-label={`Remove ${word}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function UpdatesSection({ appVersion }: { appVersion: string }) {
  const autoUpdate = usePreferencesStore((s) => s.autoUpdateOnLaunch);
  const setAutoUpdate = usePreferencesStore((s) => s.setAutoUpdateOnLaunch);
  return (
    <>
      <SectionHeader
        title="Updates"
        blurb="Skrive checks for new releases via GitHub. Auto-updater wiring lands with the v0.2 release pipeline."
      />
      <div className="settings-group">
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => setAutoUpdate(e.target.checked)}
          />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">
              Check for updates on launch
            </span>
            <span className="settings-toggle-desc">
              Silently checks GitHub Releases when the app starts. You'll only
              see a prompt if a new release is available.
            </span>
          </span>
        </label>
      </div>
      <div className="settings-group">
        <div className="settings-meta-row">
          <span className="settings-meta-label">Current version</span>
          <span className="settings-meta-value">{appVersion}</span>
        </div>
        <button
          type="button"
          className="settings-secondary-button"
          disabled
          title="Available once the auto-updater wiring lands (post-Phase 9)."
        >
          Check for updates…
        </button>
      </div>
    </>
  );
}

function AboutSection({ appVersion }: { appVersion: string }) {
  async function reveal() {
    try {
      await window.skrive.persistence.revealUserData();
    } catch (err) {
      notify.error('Could not reveal preferences', err);
    }
  }
  return (
    <>
      <SectionHeader
        title="About"
        blurb="Skrive — a Markdown editor for writers."
      />
      <div className="settings-group">
        <div className="settings-meta-row">
          <span className="settings-meta-label">Version</span>
          <span className="settings-meta-value">{appVersion}</span>
        </div>
        <div className="settings-meta-row">
          <span className="settings-meta-label">License</span>
          <span className="settings-meta-value">{APP_LICENSE_LABEL}</span>
        </div>
        <button
          type="button"
          className="settings-secondary-button"
          onClick={() => void reveal()}
        >
          Reveal preferences in Finder
        </button>
      </div>
    </>
  );
}
