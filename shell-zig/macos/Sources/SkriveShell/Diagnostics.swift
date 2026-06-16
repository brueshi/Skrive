import Foundation

// Headless smoke-test instrumentation, injected only when SKRIVE_DIAG=1.
// It is the objective complement to a manual visual test: it proves the
// app:version round-trip through all four layers (renderer -> Swift -> Zig
// -> renderer) and reports whether the renderer mounted, the workers
// loaded, and the sample document rendered — all to stdout via the
// `skriveDiag` message handler.
enum Diagnostics {
    // Mirror console.{log,info,warn,error} to the host so renderer errors
    // (e.g. a worker failing to load under file://) surface in the
    // process log. Installed at document start, before app code runs.
    static let consoleRelaySource = """
    (() => {
      const post = (level, args) => {
        try {
          const text = args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          }).join(' ');
          window.webkit.messageHandlers.skriveDiag.postMessage(level + ': ' + text);
        } catch (_) {}
      };
      for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => { post(level, args); original(...args); };
      }
      window.addEventListener('error', (e) => post('error', [String(e.message || e.error)]));
      window.addEventListener('unhandledrejection', (e) => post('error', ['unhandledrejection ' + String(e.reason)]));
    })();
    """

    // Run after the renderer settles. Round-trips the two host commands and
    // probes the DOM for the sample project's rendered content.
    static let selfTestSource = """
    (async () => {
      const result = { hasSkrive: !!window.skrive };
      try { result.version = await window.skrive.app.version(); }
      catch (e) { result.versionError = String(e); }
      try { result.platform = await window.skrive.app.platform(); }
      catch (e) { result.platformError = String(e); }
      const root = document.getElementById('root');
      result.rootChildren = root ? root.childElementCount : 0;
      const text = document.body ? document.body.innerText : '';
      result.sampleHeadingRendered = text.includes('Parity Sample');
      window.webkit.messageHandlers.skriveDiag.postMessage('SELFTEST ' + JSON.stringify(result));
    })();
    """
}
