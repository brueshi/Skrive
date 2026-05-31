// Settings as a Radix Dialog modal. Editor stays mounted underneath
// so layout-affecting prefs (shell tone, inset coverage, panel push,
// etc.) preview live against an actual document instead of fighting
// the workspace for the same slot.
//
// Sections: General, Editor, Personal dictionary, Updates, About.
// Saves are debounced through the preferences store; this component
// just dispatches actions on every change.
//
// The Updates section drives electron-updater (wired in Phase 12c):
// status subscription, manual check, and download/install affordances.
//
// Was an in-workspace view through Phase 13c; modal swap landed when
// the inset-design experiment surfaced too many layout-shift bugs in
// the swap-with-editor model.

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '@skrive/shared';
import { usePreferencesStore } from '../../stores/preferences';
import { logProjectError } from '../../stores/project';
import {
  EDITOR_FONT_PRESETS,
  FONT_SIZE_STEPS,
  LINE_HEIGHT_STEPS_X100,
  lineHeightLabel
} from '../../lib/typography';
import { notify } from '../../lib/notify';
import { IconX } from '../icons/IconX';

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
  onClose: () => void;
  appVersion: string;
};

export function SettingsModal({ open, onClose, appVersion }: Props) {
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
          className="modal-dialog settings-modal"
          aria-label="Settings"
        >
          <header className="settings-view-header">
            <Dialog.Title className="settings-view-title">
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="settings-close"
                aria-label="Close settings"
                title="Close settings  Esc"
              >
                <IconX size={16} />
              </button>
            </Dialog.Close>
          </header>
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
              {section === 'about' && <AboutSection appVersion={appVersion} />}
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

const THEME_OPTIONS: {
  id: 'system' | 'light' | 'dark';
  label: string;
  desc: string;
}[] = [
  {
    id: 'system',
    label: 'System',
    desc: 'Match the OS theme automatically.'
  },
  {
    id: 'light',
    label: 'Light',
    desc: 'Warm paper-like palette.'
  },
  {
    id: 'dark',
    label: 'Dark',
    desc: 'Original Skrive dark palette.'
  }
];

const PANEL_BEHAVIOR_OPTIONS: {
  id: 'push' | 'float';
  label: string;
  desc: string;
}[] = [
  {
    id: 'push',
    label: 'Push',
    desc: 'Editor card narrows; panel sits beside it.'
  },
  {
    id: 'float',
    label: 'Float',
    desc: 'Panel overlays the editor card without resizing it.'
  }
];

const SHELL_TONE_OPTIONS: {
  id: 'dark' | 'same' | 'light';
  label: string;
  desc: string;
}[] = [
  {
    id: 'dark',
    label: 'Shell darker',
    desc: 'Page glows on a darker desk (Linear-ish).'
  },
  {
    id: 'same',
    label: 'Same tone',
    desc: 'Card matches the shell; a subtle edge separates them.'
  },
  {
    id: 'light',
    label: 'Soft contrast',
    desc: 'A gentle desk tint — soft beige in light, a lifted desk in dark.'
  }
];

function GeneralSection() {
  const skipDelete = usePreferencesStore((s) => s.skipDeleteConfirmation);
  const setSkip = usePreferencesStore((s) => s.setSkipDeleteConfirmation);
  const showOutlineRail = usePreferencesStore((s) => s.showOutlineRail);
  const setShowOutlineRail = usePreferencesStore((s) => s.setShowOutlineRail);
  const defaultSurface = usePreferencesStore((s) => s.defaultSurface);
  const setDefaultSurface = usePreferencesStore((s) => s.setDefaultSurface);
  const panelOpenBehavior = usePreferencesStore((s) => s.panelOpenBehavior);
  const setPanelOpenBehavior = usePreferencesStore(
    (s) => s.setPanelOpenBehavior
  );
  const shellTone = usePreferencesStore((s) => s.shellTone);
  const setShellTone = usePreferencesStore((s) => s.setShellTone);
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
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
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={showOutlineRail}
            onChange={(e) => setShowOutlineRail(e.target.checked)}
          />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">Outline rail</span>
            <span className="settings-toggle-desc">
              Show a column of section ticks down the right edge of the preview.
              Hover it for a labeled outline; drag it to scrub the document.
            </span>
          </span>
        </label>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={defaultSurface === 'rich'}
            onChange={(e) => setDefaultSurface(e.target.checked ? 'rich' : 'text')}
          />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">
              Rich editing surface (experimental)
            </span>
            <span className="settings-toggle-desc">
              Edit a rich, no-syntax projection of your Markdown instead of the
              text surface. The file on disk stays plain Markdown. Early preview:
              constructs like tables and blockquotes show as raw source for now.
            </span>
          </span>
        </label>
      </div>

      <header className="settings-pane-header">
        <h2>Appearance</h2>
        <p className="settings-pane-blurb">
          Visual treatment of the workspace shell.
        </p>
      </header>

      <LayoutFork
        label="Theme"
        blurb="System follows the OS color scheme. Light and Dark pin Skrive's palette."
        options={THEME_OPTIONS}
        value={theme}
        onChange={setTheme}
      />
      <LayoutFork
        label="Shell tone"
        blurb="Color relationship between the shell and the editor card. Applies in both light and dark."
        options={SHELL_TONE_OPTIONS}
        value={shellTone}
        onChange={setShellTone}
      />
      <LayoutFork
        label="Side panels"
        blurb="What happens to the editor when a panel opens."
        options={PANEL_BEHAVIOR_OPTIONS}
        value={panelOpenBehavior}
        onChange={setPanelOpenBehavior}
      />
    </>
  );
}

type LayoutForkProps<T extends string> = {
  label: string;
  blurb: string;
  options: { id: T; label: string; desc: string }[];
  value: T;
  onChange: (value: T) => void;
};

function LayoutFork<T extends string>({
  label,
  blurb,
  options,
  value,
  onChange
}: LayoutForkProps<T>) {
  return (
    <div className="settings-group">
      <label className="settings-label">{label}</label>
      <p className="settings-pane-blurb settings-inline-blurb">{blurb}</p>
      <div className="settings-layout-grid">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`settings-layout-tile${
              value === opt.id ? ' active' : ''
            }`}
            onClick={() => onChange(opt.id)}
            aria-pressed={value === opt.id}
          >
            <span className="settings-layout-tile-label">{opt.label}</span>
            <span className="settings-layout-tile-desc">{opt.desc}</span>
          </button>
        ))}
      </div>
    </div>
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
          <p className="settings-empty">
            No words yet — right-click a misspelled word in the editor to
            add one, or type one above.
          </p>
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
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'idle' });

  useEffect(() => {
    window.skrive.updater
      .current()
      .then(setStatus)
      .catch((err) => logProjectError('updater:current', err));
    const unsubscribe = window.skrive.updater.onStatus(setStatus);
    return unsubscribe;
  }, []);

  function triggerCheck() {
    void window.skrive.updater
      .check()
      .catch((err) => logProjectError('updater:check', err));
  }

  function triggerAction() {
    void window.skrive.updater
      .downloadAndInstall()
      .catch((err) => logProjectError('updater:downloadAndInstall', err));
  }

  return (
    <>
      <SectionHeader
        title="Updates"
        blurb="Skrive checks for new releases via GitHub. Auto-download is opt-in — Skrive won't pull a new artifact in the background unless you click Download."
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
        <UpdaterControls
          status={status}
          onCheck={triggerCheck}
          onAction={triggerAction}
        />
      </div>
    </>
  );
}

function UpdaterControls({
  status,
  onCheck,
  onAction
}: {
  status: UpdaterStatus;
  onCheck: () => void;
  onAction: () => void;
}) {
  switch (status.kind) {
    case 'idle':
      return (
        <button
          type="button"
          className="settings-secondary-button"
          onClick={onCheck}
        >
          Check for updates…
        </button>
      );
    case 'checking':
      return (
        <button type="button" className="settings-secondary-button" disabled>
          Checking…
        </button>
      );
    case 'no-update':
      return (
        <>
          <p className="settings-updater-status">
            You're up to date. Last checked{' '}
            {new Date(status.checkedAtMs).toLocaleTimeString()}.
          </p>
          <button
            type="button"
            className="settings-secondary-button"
            onClick={onCheck}
          >
            Check again
          </button>
        </>
      );
    case 'available':
      return (
        <>
          <p className="settings-updater-status">
            Update available: <strong>v{status.version}</strong>
          </p>
          <button
            type="button"
            className="settings-secondary-button"
            onClick={onAction}
          >
            Download
          </button>
        </>
      );
    case 'downloading':
      return (
        <>
          <p className="settings-updater-status">
            Downloading v{status.version} — {Math.round(status.percent)}%
          </p>
          <button type="button" className="settings-secondary-button" disabled>
            Downloading…
          </button>
        </>
      );
    case 'ready':
      return (
        <>
          <p className="settings-updater-status">
            v{status.version} ready to install on next launch.
          </p>
          <button
            type="button"
            className="settings-secondary-button"
            onClick={onAction}
          >
            Restart to install
          </button>
        </>
      );
    case 'error':
      return (
        <>
          <p className="settings-updater-status settings-updater-error">
            {status.message}
          </p>
          <button
            type="button"
            className="settings-secondary-button"
            onClick={onCheck}
          >
            Try again
          </button>
        </>
      );
  }
}

function AboutSection({ appVersion }: { appVersion: string }) {
  async function reveal() {
    try {
      await window.skrive.persistence.revealUserData();
    } catch (err) {
      notify.error("Couldn't reveal preferences", err);
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
