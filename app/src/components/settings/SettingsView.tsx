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
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { EditorFontId, UpdaterStatus } from '@skrive/shared';
import {
  LINE_MEASURE_CUSTOM_MAX_CH,
  LINE_MEASURE_CUSTOM_MIN_CH
} from '@skrive/shared';
import { usePreferencesStore } from '../../stores/preferences';
import {
  AUTOSAVE_IDLE_MAX_MS,
  AUTOSAVE_IDLE_MIN_MS,
  AUTOSAVE_IDLE_STEP_MS
} from '../../stores/preferences';
import {
  logProjectError,
  useProjectStore,
  type SettingsSection as SettingsSectionId
} from '../../stores/project';
import {
  EDITOR_FONT_PRESETS,
  FONT_SIZE_STEPS,
  LINE_HEIGHT_STEPS_X100,
  lineHeightLabel,
  resolveEditorFontStack
} from '../../lib/typography';
import { BUNDLED_FONTS } from '../../lib/typography-registry';
import { notify } from '../../lib/notify';
import { openFeedbackForm } from '../../lib/feedback';
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

// The Zig shells drive updates through the OS-native updater (Sparkle on
// macOS, WinSparkle on Windows) with its own dialogs and a "Check for
// Updates…" menu item, rather than the in-app contract-driven controls below.
// When the host injects this flag, the Updates pane shows the native posture
// instead. Absent on macOS/Windows Electron, where the contract drives the UI.
declare global {
  interface Window {
    __SKRIVE_NATIVE_UPDATER__?: boolean;
  }
}

const NATIVE_UPDATER =
  typeof window !== 'undefined' && window.__SKRIVE_NATIVE_UPDATER__ === true;

type SectionId = SettingsSectionId;

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

export function SettingsView({
  appVersion,
  onReportBug,
  onSendFeedback
}: {
  appVersion: string;
  onReportBug: () => void;
  onSendFeedback: () => void;
}) {
  // A pending deep-link (e.g. the update toast requesting Updates) is read
  // from the store. Lazy-init consumes it at mount so we open directly on
  // the target with no General flash; the effect below covers the case where
  // Settings is already open and a new deep-link arrives.
  const requestedSection = useProjectStore((s) => s.settingsSection);
  const [section, setSection] = useState<SectionId>(
    () => useProjectStore.getState().settingsSection ?? 'general'
  );
  useEffect(() => {
    if (requestedSection) {
      setSection(requestedSection);
      useProjectStore.getState().clearSettingsSection();
    }
  }, [requestedSection]);
  const reduced = useReducedMotion();

  function renderSection(id: SectionId) {
    switch (id) {
      case 'general':
        return <GeneralPane />;
      case 'appearance':
        return <AppearancePane />;
      case 'editor':
        return <EditorPane />;
      case 'writing':
        return <WritingFilesPane />;
      case 'license':
        return <LicensePane />;
      case 'updates':
        return <UpdatesPane appVersion={appVersion} />;
      case 'about':
        return (
          <AboutPane
            appVersion={appVersion}
            onReportBug={onReportBug}
            onSendFeedback={onSendFeedback}
          />
        );
    }
  }

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
          {/* mode="wait" lets the outgoing page finish exiting before the
              next enters, so the swap reads as one page replacing another
              rather than a crossfade. initial={false} skips the entrance
              on first mount. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className="settings-col"
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{
                duration: reduced ? 0 : 0.16,
                ease: [0.16, 1, 0.3, 1]
              }}
            >
              {renderSection(section)}
            </motion.div>
          </AnimatePresence>
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
  const gitHistory = usePreferencesStore((s) => s.gitHistoryEnabled);
  // The action lives in the project store: it persists the preference, pushes
  // it to the shell, and refreshes the open project's history live.
  const setGitHistory = useProjectStore((s) => s.setGitHistoryEnabled);

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
      </SettingsSection>
      <SettingsSection cap="Version history">
        <SettingRow
          label="Use Git for version history"
          desc="When a project is a Git repository, source its history panel from Git. Off keeps Skrive's own checkpoint history for every project and never reads Git — useful when opening documents churns your working tree."
          control={
            <Toggle
              checked={gitHistory}
              onChange={setGitHistory}
              ariaLabel="Use Git for version history"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

/** A line of prose in the selected face, so the choice can be made by
 *  reading rather than by name. Sized a little above the editor's default so
 *  the letterforms are legible in a settings row, and exercising italic,
 *  bold, and figures because that is where faces differ most. */
function FontSpecimen({
  font,
  customFamily
}: {
  font: EditorFontId;
  customFamily: string;
}) {
  const preset = EDITOR_FONT_PRESETS.find((p) => p.id === font);
  return (
    <div className="settings-font-specimen-block">
      <p
        className="settings-font-specimen"
        style={{ fontFamily: resolveEditorFontStack(font, customFamily) }}
      >
        Good type gets out of the way. You notice the sentence, not the
        letters — the <em>shape</em> of an argument, the{' '}
        <strong>weight</strong> of a claim, a date like 1849 sitting quietly
        in the line.
      </p>
      {preset && <p className="settings-font-note">{preset.subtext}</p>}
    </div>
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
  const outlineRail = usePreferencesStore((s) => s.showOutlineRail);
  const setOutlineRail = usePreferencesStore((s) => s.setShowOutlineRail);
  const wordCount = usePreferencesStore((s) => s.showWordCount);
  const setWordCount = usePreferencesStore((s) => s.setShowWordCount);

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
                label: p.label,
                group: p.group
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
        <FontSpecimen font={editorFont} customFamily={customFamily} />
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
        <SettingRow
          label="Word count"
          desc="Show live word, character, and reading-time counts in the corner of the editor."
          control={
            <Toggle
              checked={wordCount}
              onChange={setWordCount}
              ariaLabel="Word count"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function EditorPane() {
  const lineMeasure = usePreferencesStore((s) => s.lineMeasure);
  const setLineMeasure = usePreferencesStore((s) => s.setLineMeasure);
  const lineMeasureCustomCh = usePreferencesStore(
    (s) => s.lineMeasureCustomCh
  );
  const setLineMeasureCustomCh = usePreferencesStore(
    (s) => s.setLineMeasureCustomCh
  );
  const showMeasureRule = usePreferencesStore((s) => s.showMeasureRule);
  const setShowMeasureRule = usePreferencesStore((s) => s.setShowMeasureRule);
  const smartTypography = usePreferencesStore((s) => s.smartTypography);
  const setSmartTypography = usePreferencesStore((s) => s.setSmartTypography);

  return (
    <>
      <PaneHead
        title="Editor"
        sub="Defaults for new documents and how writing behaves."
      />
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
                { id: 'wide', label: 'Wide' },
                { id: 'full', label: 'Full' },
                { id: 'custom', label: 'Custom' }
              ]}
              ariaLabel="Line measure"
            />
          }
        />
        {lineMeasure === 'custom' && (
          <SettingRow
            label="Custom measure"
            desc="Column width in characters of the editor font."
            control={
              <Stepper
                value={lineMeasureCustomCh}
                onChange={setLineMeasureCustomCh}
                min={LINE_MEASURE_CUSTOM_MIN_CH}
                max={LINE_MEASURE_CUSTOM_MAX_CH}
                step={5}
                format={(v) => `${v} ch`}
                ariaLabel="Custom measure"
              />
            }
          />
        )}
        <SettingRow
          label="Measure rule"
          desc="A hairline at the writing column's edge."
          control={
            <Toggle
              checked={showMeasureRule}
              onChange={setShowMeasureRule}
              ariaLabel="Measure rule"
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
          <Input
            type="text"
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
          <Button
            onClick={commit}
            disabled={pending.trim().length === 0}
          >
            Add
          </Button>
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
  if (NATIVE_UPDATER) return <NativeUpdatesPane appVersion={appVersion} />;
  return <ContractUpdatesPane appVersion={appVersion} />;
}

// The native-updater posture (Zig shells): Sparkle/WinSparkle own the check,
// download, verify, and install flow with their own dialogs, so the pane is
// informational — current version plus a note. No contract calls.
function NativeUpdatesPane({ appVersion }: { appVersion: string }) {
  function checkNow() {
    void window.skrive.updater
      .check()
      .catch((err) => logProjectError('updater:check', err));
  }
  return (
    <>
      <PaneHead
        title="Updates"
        sub="Skrive checks for updates automatically and verifies each one before installing."
      />
      <SettingsSection cap="Status">
        <SettingRow
          label="Current version"
          desc="The build you're running now."
          control={<span className="settings-value-text">v{appVersion}</span>}
        />
        <div className="settings-card-pad">
          <p className="settings-updater-status">
            Skrive checks GitHub Releases on its own and notifies you when a new
            version is ready. Updates are signed and verified before they
            install.
          </p>
          <Button
            onClick={checkNow}
          >
            Check for updates…
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

function ContractUpdatesPane({ appVersion }: { appVersion: string }) {
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
          <UpdaterCard
            status={status}
            onCheck={triggerCheck}
            onAction={triggerAction}
          />
        </div>
      </SettingsSection>
    </>
  );
}

/** Human-readable transfer rate, e.g. "3.1 MB/s". Empty when unknown. */
function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}/s`;
}

/**
 * The contract-driven updater surface, as a state-aware card. `available` and
 * `ready` lift to an accent-edged card with a primary CTA; `downloading` shows
 * a live progress bar. The plain states (idle/checking/no-update) stay quiet.
 */
function UpdaterCard({
  status,
  onCheck,
  onAction
}: {
  status: UpdaterStatus;
  onCheck: () => void;
  onAction: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const accented = status.kind === 'available' || status.kind === 'ready';
  const className = [
    'updater-card',
    accented ? 'is-accent' : '',
    status.kind === 'error' ? 'is-error' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      {renderUpdaterBody(status, onCheck, onAction, reduceMotion ?? false)}
    </div>
  );
}

function renderUpdaterBody(
  status: UpdaterStatus,
  onCheck: () => void,
  onAction: () => void,
  reduceMotion: boolean
) {
  switch (status.kind) {
    case 'idle':
      return (
        <div className="updater-card-row">
          <span className="updater-card-title">Check for updates</span>
          <Button onClick={onCheck}>
            Check now
          </Button>
        </div>
      );
    case 'checking':
      return (
        <div className="updater-card-row">
          <span className="updater-card-title">
            <span className="updater-spinner" aria-hidden="true" />
            Checking for updates…
          </span>
        </div>
      );
    case 'no-update':
      return (
        <div className="updater-card-row">
          <span className="updater-card-title">
            You&rsquo;re up to date
            <span className="updater-card-sub">
              Last checked{' '}
              {new Date(status.checkedAtMs).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit'
              })}
            </span>
          </span>
          <Button onClick={onCheck}>
            Check again
          </Button>
        </div>
      );
    case 'available':
      return (
        <>
          <div className="updater-card-row">
            <span className="updater-card-title">
              Update available
              <span className="updater-card-version">Skrive {status.version}</span>
            </span>
            <Button variant="primary" onClick={onAction}>
              Download
            </Button>
          </div>
          {status.releaseNotes ? (
            <div className="updater-card-notes">{status.releaseNotes}</div>
          ) : null}
        </>
      );
    case 'downloading':
      return (
        <div className="updater-card-stack">
          <span className="updater-card-title">Downloading Skrive {status.version}</span>
          <div
            className="updater-progress"
            role="progressbar"
            aria-valuenow={Math.round(status.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <motion.div
              className="updater-progress-fill"
              animate={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: 'easeOut' }}
            />
          </div>
          <span className="updater-card-meta">
            {Math.round(status.percent)}%
            {formatSpeed(status.bytesPerSecond) ? ` · ${formatSpeed(status.bytesPerSecond)}` : ''}
          </span>
        </div>
      );
    case 'ready':
      return (
        <div className="updater-card-row">
          <span className="updater-card-title">
            Ready to install
            <span className="updater-card-version">Skrive {status.version}</span>
          </span>
          <Button variant="primary" onClick={onAction}>
            Restart to install
          </Button>
        </div>
      );
    case 'error':
      return (
        <div className="updater-card-stack">
          <span className="updater-card-title">Update failed</span>
          <p className="updater-card-error">{status.message}</p>
          <Button onClick={onCheck}>
            Try again
          </Button>
        </div>
      );
  }
}

function AboutPane({
  appVersion,
  onReportBug,
  onSendFeedback
}: {
  appVersion: string;
  onReportBug: () => void;
  onSendFeedback: () => void;
}) {
  async function reveal() {
    try {
      await window.skrive.persistence.revealUserData();
    } catch (err) {
      notify.error("Couldn't reveal preferences", err);
    }
  }
  async function revealDiagnostics() {
    try {
      await window.skrive.log.reveal();
    } catch (err) {
      notify.error("Couldn't reveal diagnostics", err);
    }
  }
  return (
    <>
      <PaneHead title="About" sub="Skrive — rich, rendered writing in plain files you own." />
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
          <Button
            onClick={() => void reveal()}
          >
            Reveal preferences in Finder
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection cap="Fonts">
        <div className="settings-card-pad">
          <p className="settings-card-blurb">
            Skrive bundles these writing faces, each under the SIL Open Font
            License 1.1. The full license ships beside the font files inside
            the app.
          </p>
          <ul className="settings-credit-list">
            {BUNDLED_FONTS.map((font) => (
              <li key={font.id} className="settings-credit-row">
                <span className="settings-credit-name">{font.label}</span>
                <span className="settings-credit-by">{font.credit}</span>
              </li>
            ))}
          </ul>
        </div>
      </SettingsSection>
      <SettingsSection cap="Diagnostics">
        <SettingRow
          label="Crash & error logs"
          desc="Local only — nothing is ever uploaded. If Skrive misbehaves, reveal the folder and send us the files."
          control={
            <Button
              onClick={() => void revealDiagnostics()}
            >
              Reveal diagnostics
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection cap="Feedback">
        <SettingRow
          label="Report a bug"
          desc="Something broken? Send a report straight to our tracker — only what you write is sent, never your documents."
          control={
            <Button
              onClick={onReportBug}
            >
              Report a bug
            </Button>
          }
        />
        <SettingRow
          label="Send feedback"
          desc="Ideas, requests, or what could be better — sent straight to our tracker, in the app."
          control={
            <Button
              onClick={onSendFeedback}
            >
              Send feedback
            </Button>
          }
        />
        <SettingRow
          label="Share feedback"
          desc="Tell us what's working and what isn't. Opens a short form in your browser."
          control={
            <Button
              onClick={() => openFeedbackForm()}
            >
              Open form
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}
