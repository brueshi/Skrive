// Experimental opt-in for the bespoke block surface (SKR-95, Stage 3h). The
// shipping editor stays primary; this flag swaps it for the bespoke surface so
// the new engine can be driven in the real shell (WKWebView / WebView2) before
// the Stage 5 cutover.
//
// Read once at module load (mirrors the perf flag): via the Vite env, or a
// localStorage bit so it can be flipped in the running app without a rebuild —
//   localStorage.setItem('skrive.blockSurface', '1')  (then reload: ⌘R)
// Deliberately NOT in AppUiState: keeping it out of the persisted, cross-shell
// schema means no parity-corpus / Zig-core-default churn for an experiment.

const LS_KEY = 'skrive.blockSurface';

function readFlag(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SKRIVE_BLOCK === '1') return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when the bespoke block surface should replace the shipping editor. */
export const blockSurfaceEnabled = readFlag();
