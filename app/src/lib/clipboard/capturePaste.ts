// DEV-ONLY paste-capture harness — SKR-119 scaffolding.
//
// Snapshots the raw clipboard payload Skrive actually receives, so that paste
// fixtures come from *real* sources (web pages, Notion, Obsidian) rather than
// hand-authored HTML. Clipboard contents are machine- and app-specific, so the
// only honest way to test "pastes cleanly" is to assert against what your
// machine genuinely puts on the clipboard.
//
// This is NOT shipped behaviour. The listener is installed only in dev
// (import.meta.env.DEV) and stays inert until explicitly enabled. It is
// scaffolding for building the fixture corpus and is intended to be removed
// (or left dormant behind the flag) before SKR-119 merges. Cost when off: one
// early-return per paste.
//
// Usage (devtools console — no rebuild, survives HMR):
//   __skriveCapturePaste.on('notion')   enable; tag the next captures "notion"
//   <paste from the source into the app>
//   __skriveCapturePaste.label('web')   retag without toggling
//   __skriveCapturePaste.off()          disable
//
// On each capture it intercepts the paste (so nothing lands in the document),
// serialises every clipboardData entry to JSON, downloads it as
// `skrive-paste-<label>-NN.json`, and logs the same object to the console as a
// fallback for hosts that suppress the download (the native shell).

import { toast } from 'sonner';
import { writeTextToClipboard } from './systemClipboard';

const FLAG = 'skrive:capture-paste';
const LABEL_KEY = 'skrive:capture-paste:label';

interface CapturedFile {
  name: string;
  type: string;
  size: number;
}

interface PasteSnapshot {
  capturedAt: string;
  // Source tag set via on(label)/label() so each fixture knows where it came
  // from (web / notion / obsidian) without inspecting its bytes.
  label: string | null;
  types: string[];
  data: Record<string, string>;
  files: CapturedFile[];
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function enabled(): boolean {
  return readFlag(FLAG) === '1';
}

let pasteCount = 0;

function snapshot(dt: DataTransfer): PasteSnapshot {
  const types = Array.from(dt.types);
  const data: Record<string, string> = {};
  for (const type of types) {
    // getData on the synthetic 'Files' type returns '' — only string entries
    // carry data, so a non-empty guard keeps the snapshot to real payloads.
    const value = dt.getData(type);
    if (value) data[type] = value;
  }
  const files: CapturedFile[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const file = dt.files.item(i);
    if (!file) continue;
    files.push({ name: file.name, type: file.type, size: file.size });
  }
  return {
    capturedAt: new Date().toISOString(),
    label: readFlag(LABEL_KEY),
    types,
    data,
    files
  };
}

function isNativeShell(): boolean {
  return (
    (window as unknown as { __SKRIVE_NATIVE_SHELL__?: boolean })
      .__SKRIVE_NATIVE_SHELL__ === true
  );
}

// Browser path: download the snapshot as a file (lands in ~/Downloads).
// Returns false if the host throws (caller falls back to the console copy).
// WKWebView has no download delegate, so this is browser-only — the native
// shell uses the clipboard route instead.
function downloadSnapshot(json: string, label: string | null): boolean {
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const tag = label ? `${label}-` : '';
    anchor.href = url;
    anchor.download = `skrive-paste-${tag}${String(pasteCount).padStart(2, '0')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Defer revoke: the click navigation loads the blob asynchronously, so a
    // synchronous revoke can race the read.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

function onPasteCapture(event: Event): void {
  if (!enabled()) return;
  const clipboard = event as ClipboardEvent;
  const dt = clipboard.clipboardData;
  if (!dt) return;
  // Claim the event so nothing lands in the open document, and stop the
  // surface's own capture-phase paste listener (on a descendant) from also
  // firing — window capture runs before the container's.
  clipboard.preventDefault();
  clipboard.stopImmediatePropagation();
  const snap = snapshot(dt);
  const json = JSON.stringify(snap, null, 2);
  pasteCount++;
  // Console copy is always emitted as the last-resort fallback.
  // eslint-disable-next-line no-console
  console.log('[skrive-capture] paste snapshot', snap);
  const count = snap.types.length;
  const types = `${count} type${count === 1 ? '' : 's'}`;
  if (isNativeShell()) {
    // Native shell can't download a blob, but the shell clipboard bridge is
    // reliable — put the JSON there so it can be pasted straight to Claude.
    void writeTextToClipboard(json).then(
      () => toast.success(`Captured paste — ${types} — JSON on clipboard, paste it to Claude`),
      () => toast.error(`Captured paste — ${types} — clipboard write failed, see console`)
    );
  } else {
    const ok = downloadSnapshot(json, snap.label);
    toast.success(`Captured paste — ${types}${ok ? ' (downloaded)' : ' (see console)'}`);
  }
}

interface CaptureApi {
  on(label?: string): string;
  off(): string;
  label(value: string | null): string;
  status(): { enabled: boolean; label: string | null; count: number };
}

function setFlag(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / no storage: capture simply stays off */
  }
}

// Install the capture listener and expose the console toggle. Returns an
// uninstaller for the dev effect's cleanup. Idempotent at the listener level
// because addEventListener dedupes an identical (fn, capture) pair.
export function installPasteCapture(): () => void {
  window.addEventListener('paste', onPasteCapture, { capture: true });
  const api: CaptureApi = {
    on(label) {
      setFlag(FLAG, '1');
      if (label !== undefined) setFlag(LABEL_KEY, label);
      const tag = readFlag(LABEL_KEY);
      return `paste capture ON${tag ? ` (label: ${tag})` : ''} — paste into the app`;
    },
    off() {
      setFlag(FLAG, null);
      return 'paste capture OFF';
    },
    label(value) {
      setFlag(LABEL_KEY, value);
      return `label: ${value ?? '(none)'}`;
    },
    status() {
      return { enabled: enabled(), label: readFlag(LABEL_KEY), count: pasteCount };
    }
  };
  (window as unknown as { __skriveCapturePaste?: CaptureApi }).__skriveCapturePaste =
    api;
  return () => {
    window.removeEventListener('paste', onPasteCapture, { capture: true });
    delete (window as unknown as { __skriveCapturePaste?: CaptureApi })
      .__skriveCapturePaste;
  };
}
