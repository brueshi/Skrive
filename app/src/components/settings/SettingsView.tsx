// Settings as a full-page, in-workspace view (Skrive 1.0). Replaces the
// Radix-dialog SettingsModal: a left section-nav card beside a scrolling
// content card, with the topbar reduced to Back / Settings / Done (see
// Header's settings branch). The editor stays mounted under the
// 'editor' view; switching activeView swaps this in.
//
// Sections: General · Appearance · Editor · Writing & Files (Preferences)
// · License (Account) · Updates · About. Existing prefs are remapped into
// the new IA; the ten 1.0 prefs (persistence.ts) get their controls here.
// Per the 1.0 build plan, shell-tone, the accent picker, and the
// interface/display font trio from the mock are intentionally omitted.

import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '@skrive/shared';
import { usePreferencesStore } from '../../stores/preferences';
import {
  AUTOSAVE_IDLE_MAX_MS,
  AUTOSAVE_IDLE_MIN_MS,
  AUTOSAVE_IDLE_STEP_MS
} from '../../stores/preferences';
import { logProjectError } from '../../stores/project';
import {
  EDITOR_FONT_PRESETS,
  FONT_SIZE_STEPS,
  LINE_HEIGHT_STEPS_X100,
  lineHeightLabel
} from '../../lib/typography';
import { notify } from '../../lib/notify';
import {
  FieldChips,
  MonoInput,
  Segmented,
  Select,
  SettingRow,
  SettingsSection,
  Stepper,
  ThemeTiles,
  Toggle
} from './kit';

type SectionId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'writing'
  | 'license'
  | 'updates'
  | 'about';

type NavItem = { id: SectionId; label: string };
type NavGroup = { cap: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    cap: 'Preferences',
    items: [
      { id: 'general', label: 'General' },
      { id: 'appearance', label: 'Appearance' },
      { id: 'editor', label: 'Editor' },
      { id: 'writing', label: 'Writing & Files' }
    ]
  },
  { cap: 'Account', items: [{ id: 'license', label: 'License' }] },
  {
    cap: 'About',
    items: [
      { id: 'updates', label: 'Updates' },
      { id: 'about', label: 'About Skrive' }
    ]
  }
];

const APP_LICENSE_LABEL = 'PolyForm Noncommercial 1.0.0';

export function SettingsView({ appVersion }: { appVersion: string }) {
  const [section, setSection] = useState<SectionId>('general');

  return (
    <>
      <aside className="settings-nav-card" aria-label="Settings sections">
        <nav className="settings-nav-scroll">
          {NAV_GROUPS.map((group) => (
            <div key={group.cap} className="settings-nav-group">
              <h2 className="settings-nav-cap">{group.cap}</h2>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${
                    section === item.id ? ' active' : ''
                  }`}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                >
                  <span className="settings-nav-label">{item.label}</span>
                  {item.id === 'updates' && (
                    <span className="settings-nav-trailing">v{appVersion}</span>
                  )}
                  {item.id === 'license' && (
                    <span className="settings-nav-dot" aria-hidden />
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-nav-footer">
          <span className="settings-wordmark">Skrive</span>
        </div>
      </aside>

      <section className="settings-content-card">
        <div className="settings-scroll">
          <div className="settings-col">
            {section === 'general' && <GeneralPane />}
            {section === 'appearance' && <AppearancePane />}
            {section === 'editor' && <EditorPane />}
            {section === 'writing' && <WritingFilesPane />}
            {section === 'license' && <LicensePane />}
            {section === 'updates' && <UpdatesPane appVersion={appVersion} />}
            {section === 'about' && <AboutPane appVersion={appVersion} />}
          </div>
        </div>
      </section>
    </>
  );
}

function PaneHead({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="settings-pane-head">
      <h1 className="settings-pane-title">{title}</h1>
      <p className="settings-pane-sub">{sub}</p>
    </header>
  );
}

function GeneralPane() {
  const skipDelete = usePreferencesStore((s) => s.skipDeleteConfirmation);
  const setSkip = usePreferencesStore((s) => s.setSkipDeleteConfirmation);
  const switching = usePreferencesStore((s) => s.surfaceSwitchingEnabled);
  const setSwitching = usePreferencesStore((s) => s.setSurfaceSwitchingEnabled);

  return (
    <>
      <PaneHead
        title="General"
        sub="App-wide behavior. These settings apply across every project you open."
      />
      <SettingsSection cap="Behavior">
        <SettingRow
          label="Skip delete confirmation"
          desc="Move files straight to trash without the confirmation modal. Trash is reversible from Finder/Explorer."
          control={
            <Toggle
              checked={skipDelete}
              onChange={setSkip}
              ariaLabel="Skip delete confirmation"
            />
          }
        />
        <SettingRow
          label="Allow switching surfaces"
          desc="Let ⌘⇧E and the command palette flip between the Rich and Text surfaces. Off locks the editor to the default surface."
          control={
            <Toggle
              checked={switching}
              onChange={setSwitching}
              ariaLabel="Allow switching surfaces"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function AppearancePane() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const editorFont = usePreferencesStore((s) => s.editorFont);
  const setEditorFont = usePreferencesStore((s) => s.setEditorFont);
  const customFamily = usePreferencesStore((s) => s.editorCustomFontFamily);
  const setCustom = usePreferencesStore((s) => s.setEditorCustomFontFamily);
  const fontSize = usePreferencesStore((s) => s.editorFontSize);
  const setSize = usePreferencesStore((s) => s.setEditorFontSize);
  const lineHeight = usePreferencesStore((s) => s.editorLineHeightX100);
  const setLine = usePreferencesStore((s) => s.setEditorLineHeightX100);
  const panelBehavior = usePreferencesStore((s) => s.panelOpenBehavior);
  const setPanelBehavior = usePreferencesStore((s) => s.setPanelOpenBehavior);
  const outlineRail = usePreferencesStore((s) => s.showOutlineRail);
  const setOutlineRail = usePreferencesStore((s) => s.setShowOutlineRail);

  return (
    <>
      <PaneHead
        title="Appearance"
        sub="How Skrive looks and reads. These apply across every project."
      />
      <SettingsSection cap="Theme">
        <div className="settings-theme-block">
          <ThemeTiles value={theme} onChange={setTheme} />
        </div>
      </SettingsSection>

      <SettingsSection cap="Typography">
        <SettingRow
          label="Reading font"
          desc="Your prose, in both the editor and the preview."
          control={
            <Select
              value={editorFont}
              onChange={setEditorFont}
              options={EDITOR_FONT_PRESETS.map((p) => ({
                id: p.id,
                label: p.label
              }))}
              ariaLabel="Reading font"
            />
          }
        />
        {editorFont === 'custom' && (
          <SettingRow
            label="Custom family"
            desc="The editor falls back gracefully when the font isn't installed."
            control={
              <MonoInput
                value={customFamily}
                onChange={setCustom}
                ariaLabel="Custom font family"
                width={200}
              />
            }
          />
        )}
        <SettingRow
          label="Text size"
          desc="Base reading size for your prose."
          control={
            <Stepper
              value={fontSize}
              onChange={setSize}
              values={FONT_SIZE_STEPS}
              format={(v) => `${v} px`}
              ariaLabel="Text size"
            />
          }
        />
        <SettingRow
          label="Line height"
          desc="Vertical rhythm of the writing column."
          control={
            <Stepper
              value={lineHeight}
              onChange={setLine}
              values={LINE_HEIGHT_STEPS_X100}
              format={lineHeightLabel}
              ariaLabel="Line height"
            />
          }
        />
      </SettingsSection>

      <SettingsSection cap="Layout">
        <SettingRow
          label="Panel behavior"
          desc="Whether side panels push the editor aside or float over it."
          control={
            <Segmented
              value={panelBehavior}
              onChange={setPanelBehavior}
              options={[
                { id: 'push', label: 'Push' },
                { id: 'float', label: 'Float' }
              ]}
              ariaLabel="Panel behavior"
            />
          }
        />
        <SettingRow
          label="Outline rail"
          desc="Show a column of section ticks down the right edge of the preview."
          control={
            <Toggle
              checked={outlineRail}
              onChange={setOutlineRail}
              ariaLabel="Outline rail"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function EditorPane() {
  const defaultSurface = usePreferencesStore((s) => s.defaultSurface);
  const setDefaultSurface = usePreferencesStore((s) => s.setDefaultSurface);
  const markerMode = usePreferencesStore((s) => s.markerMode);
  const setMarkerMode = usePreferencesStore((s) => s.setMarkerMode);
  const lineMeasure = usePreferencesStore((s) => s.lineMeasure);
  const setLineMeasure = usePreferencesStore((s) => s.setLineMeasure);
  const smartTypography = usePreferencesStore((s) => s.smartTypography);
  const setSmartTypography = usePreferencesStore((s) => s.setSmartTypography);

  // Marker mode only affects the Text surface; dim it when Rich is the
  // default so the dependency reads at a glance (it stays editable).
  const markerDimmed = defaultSurface === 'rich';

  return (
    <>
      <PaneHead
        title="Editor"
        sub="Defaults for new documents and how writing behaves."
      />
      <SettingsSection cap="Defaults">
        <SettingRow
          label="Default surface"
          desc="Which surface new documents open in."
          control={
            <Segmented
              value={defaultSurface}
              onChange={setDefaultSurface}
              options={[
                { id: 'rich', label: 'Rich' },
                { id: 'text', label: 'Text' }
              ]}
              ariaLabel="Default surface"
            />
          }
        />
        <SettingRow
          label="Marker mode"
          desc="How much Markdown syntax shows in the Text surface."
          dimmed={markerDimmed}
          control={
            <Select
              value={markerMode}
              onChange={setMarkerMode}
              options={[
                { id: 'raw', label: 'Raw' },
                { id: 'recessed', label: 'Recessed' },
                { id: 'concealed', label: 'Concealed' }
              ]}
              ariaLabel="Marker mode"
            />
          }
        />
      </SettingsSection>

      <SettingsSection cap="Writing">
        <SettingRow
          label="Line measure"
          desc="Width of the writing column."
          control={
            <Segmented
              value={lineMeasure}
              onChange={setLineMeasure}
              options={[
                { id: 'narrow', label: 'Narrow' },
                { id: 'normal', label: 'Normal' },
                { id: 'wide', label: 'Wide' }
              ]}
              ariaLabel="Line measure"
            />
          }
        />
        <SettingRow
          label="Smart typography"
          desc="Curly quotes, em dashes, and ellipses as you type."
          control={
            <Toggle
              checked={smartTypography}
              onChange={setSmartTypography}
              ariaLabel="Smart typography"
            />
          }
        />
      </SettingsSection>

      <DictionarySection />
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

  return (
    <SettingsSection cap="Personal dictionary">
      <div className="settings-card-pad">
        <p className="settings-card-blurb">
          Words here are layered on top of the OS spellchecker. Project-scoped
          words live in .skrive.toml under [dictionary].project_words.
        </p>
        <div className="settings-dict-input">
          <input
            type="text"
            className="settings-input"
            placeholder="Add a word…"
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
            }}
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
            No words yet — right-click a misspelled word in the editor to add
            one, or type one above.
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
    </SettingsSection>
  );
}

function WritingFilesPane() {
  const newFileLocation = usePreferencesStore((s) => s.newFileLocation);
  const setNewFileLocation = usePreferencesStore((s) => s.setNewFileLocation);
  const newFileNaming = usePreferencesStore((s) => s.newFileNaming);
  const setNewFileNaming = usePreferencesStore((s) => s.setNewFileNaming);
  const slugFormat = usePreferencesStore((s) => s.slugFormat);
  const setSlugFormat = usePreferencesStore((s) => s.setSlugFormat);
  const idleDelay = usePreferencesStore((s) => s.autosaveIdleDelayMs);
  const setIdleDelay = usePreferencesStore((s) => s.setAutosaveIdleDelayMs);
  const formatOnSave = usePreferencesStore((s) => s.formatOnSave);
  const setFormatOnSave = usePreferencesStore((s) => s.setFormatOnSave);
  const seed = usePreferencesStore((s) => s.seedFrontmatter);
  const setSeed = usePreferencesStore((s) => s.setSeedFrontmatter);
  const fields = usePreferencesStore((s) => s.frontmatterFields);
  const setFields = usePreferencesStore((s) => s.setFrontmatterFields);
  const dateFormat = usePreferencesStore((s) => s.dateFormat);
  const setDateFormat = usePreferencesStore((s) => s.setDateFormat);

  return (
    <>
      <PaneHead
        title="Writing & Files"
        sub="How documents are named, saved, and seeded on disk."
      />
      <SettingsSection cap="Files">
        <SettingRow
          label="New file location"
          desc="Where new documents are created."
          control={
            <Select
              value={newFileLocation}
              onChange={setNewFileLocation}
              options={[
                { id: 'activeFolder', label: 'Same folder as active' },
                { id: 'projectRoot', label: 'Project root' }
              ]}
              ariaLabel="New file location"
            />
          }
        />
        <SettingRow
          label="Name new files from"
          desc="The filename is derived as you write the title."
          control={
            <Select
              value={newFileNaming}
              onChange={setNewFileNaming}
              options={[
                { id: 'title', label: 'Document title' },
                { id: 'untitled', label: 'Untitled' }
              ]}
              ariaLabel="Name new files from"
            />
          }
        />
        <SettingRow
          label="Slug format"
          desc="Used for heading anchors and wiki links."
          control={
            <Select
              value={slugFormat}
              onChange={setSlugFormat}
              options={[
                { id: 'kebab-case', label: 'kebab-case' },
                { id: 'snake_case', label: 'snake_case' }
              ]}
              ariaLabel="Slug format"
            />
          }
        />
      </SettingsSection>

      <SettingsSection cap="Saving">
        <SettingRow
          label="Idle delay"
          desc="How long to wait after you stop typing before autosaving."
          control={
            <Stepper
              value={idleDelay}
              onChange={setIdleDelay}
              min={AUTOSAVE_IDLE_MIN_MS}
              max={AUTOSAVE_IDLE_MAX_MS}
              step={AUTOSAVE_IDLE_STEP_MS}
              format={(v) => `${v} ms`}
              ariaLabel="Autosave idle delay"
            />
          }
        />
        <SettingRow
          label="Format on save"
          desc="Normalize Markdown spacing when a file is saved."
          control={
            <Toggle
              checked={formatOnSave}
              onChange={setFormatOnSave}
              ariaLabel="Format on save"
            />
          }
        />
      </SettingsSection>

      <SettingsSection cap="Frontmatter">
        <SettingRow
          label="Seed new files"
          desc="Start new documents with a frontmatter block."
          control={
            <Toggle
              checked={seed}
              onChange={setSeed}
              ariaLabel="Seed new files with frontmatter"
            />
          }
        />
        <SettingRow
          label="Default fields"
          desc="Inserted into every new document."
          dimmed={!seed}
          control={<FieldChips fields={fields} onChange={setFields} />}
        />
        <SettingRow
          label="Date format"
          desc="For the seeded date field."
          dimmed={!seed}
          control={
            <MonoInput
              value={dateFormat}
              onChange={setDateFormat}
              ariaLabel="Date format"
              width={130}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function LicensePane() {
  const license = usePreferencesStore((s) => s.license);
  return (
    <>
      <PaneHead
        title="License"
        sub="Your Skrive license and how it's applied."
      />
      <SettingsSection cap="Status">
        <SettingRow
          label="Edition"
          desc="Skrive is source-available under PolyForm Noncommercial."
          control={<span className="settings-value-text">{APP_LICENSE_LABEL}</span>}
        />
        <SettingRow
          label="License key"
          desc={
            license
              ? 'A key is on file for this install.'
              : 'No key on file — running under the Noncommercial license.'
          }
          control={
            <span className="settings-value-text settings-value-mono">
              {license ?? '—'}
            </span>
          }
        />
      </SettingsSection>
    </>
  );
}

function UpdatesPane({ appVersion }: { appVersion: string }) {
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
      <PaneHead
        title="Updates"
        sub="Skrive checks GitHub Releases. Auto-download is opt-in — nothing is pulled in the background unless you ask."
      />
      <SettingsSection cap="Automatic">
        <SettingRow
          label="Check for updates on launch"
          desc="Silently checks GitHub when the app starts. You'll only see a prompt if a new release is available."
          control={
            <Toggle
              checked={autoUpdate}
              onChange={setAutoUpdate}
              ariaLabel="Check for updates on launch"
            />
          }
        />
      </SettingsSection>
      <SettingsSection cap="Status">
        <SettingRow
          label="Current version"
          desc="The build you're running now."
          control={<span className="settings-value-text">v{appVersion}</span>}
        />
        <div className="settings-card-pad">
          <UpdaterControls
            status={status}
            onCheck={triggerCheck}
            onAction={triggerAction}
          />
        </div>
      </SettingsSection>
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
        <button type="button" className="settings-secondary-button" onClick={onCheck}>
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
          <button type="button" className="settings-secondary-button" onClick={onCheck}>
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
          <button type="button" className="settings-secondary-button" onClick={onAction}>
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
          <button type="button" className="settings-secondary-button" onClick={onAction}>
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
          <button type="button" className="settings-secondary-button" onClick={onCheck}>
            Try again
          </button>
        </>
      );
  }
}

function AboutPane({ appVersion }: { appVersion: string }) {
  async function reveal() {
    try {
      await window.skrive.persistence.revealUserData();
    } catch (err) {
      notify.error("Couldn't reveal preferences", err);
    }
  }
  return (
    <>
      <PaneHead title="About" sub="Skrive — a Markdown editor for writers." />
      <SettingsSection cap="Build">
        <SettingRow
          label="Version"
          desc="The build you're running now."
          control={<span className="settings-value-text">v{appVersion}</span>}
        />
        <SettingRow
          label="License"
          desc="Source-available, noncommercial."
          control={<span className="settings-value-text">{APP_LICENSE_LABEL}</span>}
        />
        <div className="settings-card-pad">
          <button
            type="button"
            className="settings-secondary-button"
            onClick={() => void reveal()}
          >
            Reveal preferences in Finder
          </button>
        </div>
      </SettingsSection>
    </>
  );
}
