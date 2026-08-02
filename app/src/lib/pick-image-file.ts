// The deliberate "insert an image" file choice, behind a throwaway
// `<input type="file">`.
//
// Why a file input rather than a bridge call. Skrive's shell already exposes a
// folder picker over IPC, and adding a file flavour of it would mean a new
// contract method on every host plus a binary read to get the bytes back across
// the bridge. The web platform already has both: the input yields a `File`,
// which is byte-for-byte what a paste or a drop hands the block surface. So the
// picker route joins the paste route at the same landing code, and the hosts
// stay out of it — except for one thing they cannot stay out of, see below.
//
// THE HOST CATCH: on macOS a WKWebView only shows a file panel if its UI
// delegate implements `runOpenPanelWith`. Without it the input's click is
// swallowed and NOTHING happens — no panel, no error, no event. WebView2 on
// Windows and Chromium (the gates, the latency harness) all open the panel
// natively, so nothing short of the real macOS shell can catch that regression.
// See SkriveShell's AppDelegate.
//
// Settling exactly once is the other subtlety. `change` fires on a choice, and
// `cancel` fires on a dismissal in current WebKit — but `cancel` is recent
// enough that it cannot be the only escape hatch, and a promise that never
// settles would leave the caller waiting forever on an image that is never
// coming. The window regaining focus is the backstop: the panel is modal, so
// focus returning without a `change` means the writer dismissed it.

import { imageExtension, imageMimeFromFilename } from './clipboard/pasteImage';

/** Grace period after focus returns before a silent picker counts as a cancel.
 *  `change` fires immediately after focus does, so this only has to outlast the
 *  same-task gap between the two events. */
const CANCEL_GRACE_MS = 400;

export type PickedImage = { file: File; mimeType: string };

/**
 * Open the host's image picker and resolve with the chosen file, or null if the
 * writer dismissed it. A cancel is a normal outcome, not an error.
 *
 * The accept list is the set the rest of the image path already understands
 * (`imageExtension`), so the panel cannot offer a file that would then be
 * declined after the fact. It still can be handed one — an accept list is a
 * filter, not a guarantee, and some WebKit builds report no `type` at all — so
 * the type is re-derived from the filename when it is missing, and a genuinely
 * unsupported file REJECTS. It must not resolve null: null means "the writer
 * chose nothing", and a chosen file that quietly vanishes is the silent no-op
 * this whole path exists to avoid.
 */
export function pickImageFile(): Promise<PickedImage | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif,image/bmp';
    // Off-screen rather than display:none — a hidden input is not guaranteed to
    // be clickable, and this one has to be.
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);

    let settled = false;
    let graceTimer: number | undefined;
    const teardown = () => {
      settled = true;
      window.clearTimeout(graceTimer);
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
    };
    const finish = (picked: PickedImage | null) => {
      if (settled) return;
      teardown();
      resolve(picked);
    };
    const fail = (message: string) => {
      if (settled) return;
      teardown();
      reject(new Error(message));
    };

    const onChange = () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const mimeType = file.type || imageMimeFromFilename(file.name) || '';
      if (!imageExtension(mimeType)) {
        return fail(`Skrive can't insert ${file.name.split('.').pop() ?? 'that'} images yet`);
      }
      finish({ file, mimeType });
    };
    // The window regains focus when the panel closes, whether or not anything
    // was chosen; `change` lands right after it on a choice, so wait out the
    // grace period before calling it a cancel. Focus can bounce more than once
    // while the panel tears down, so the pending timer is always replaced rather
    // than stacked — an early one firing would report a cancel over a choice.
    const onWindowFocus = () => {
      window.clearTimeout(graceTimer);
      graceTimer = window.setTimeout(() => finish(null), CANCEL_GRACE_MS);
    };

    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window.addEventListener('focus', onWindowFocus);
    input.click();
  });
}
