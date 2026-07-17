// The syntax-highlight Worker. Tokenizes one code block at a time, off the main
// thread, so highlighting never lands on the keystroke path (the typing latency
// gate). It mirrors the lint worker's shape: a thin message shell around a pure,
// IPC-free compute function (`tokenizeToRanges`) that is imported unchanged and is
// therefore just as safe to host here.
//
// The worker is stateless — each request carries the full block text and its
// language. Incrementality lives on the main thread (it only ever asks for the one
// block that changed), so there is nothing to cache across messages.

import { tokenizeToRanges } from './tokenize';
import type {
  HighlightRequest,
  HighlightResponse
} from './highlight-worker-protocol';

// The app's tsconfig ships the DOM lib (not WebWorker), so `self` is typed as a
// Window. Narrow it to just the surface we use rather than pulling in the
// WebWorker lib, which would clash with DOM's duplicate global declarations.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage: (message: HighlightResponse) => void;
};

ctx.onmessage = (event) => {
  const msg = event.data;
  if (msg.type !== 'highlight') return;
  const tokens = tokenizeToRanges(msg.text, msg.lang);
  ctx.postMessage({ type: 'tokens', seq: msg.seq, blockId: msg.blockId, tokens });
};
