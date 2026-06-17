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
      window.__skriveErrorCount = 0;
      const post = (level, args) => {
        try {
          if (level === 'error') window.__skriveErrorCount++;
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
      const result = { hasSkrive: !!window.skrive, serveMode: '%SERVE%' };

      // Round-trip (renderer -> Swift -> Zig -> renderer).
      try { result.version = await window.skrive.app.version(); }
      catch (e) { result.versionError = String(e); }
      try { result.platform = await window.skrive.app.platform(); }
      catch (e) { result.platformError = String(e); }

      // UI render + worker (manifest derives from the snapshot in a
      // module worker, so a rendered heading proves the worker ran).
      const root = document.getElementById('root');
      result.rootChildren = root ? root.childElementCount : 0;
      const text = document.body ? document.body.innerText : '';
      result.uiRendered = text.includes('Quiet Craft of Reading');
      result.workerErrors = window.__skriveErrorCount || 0;

      // Secure context (informational; expected false for scheme/file).
      result.isSecureContext = window.isSecureContext === true;

      // localStorage round-trip + cross-relaunch persistence.
      try {
        result.localStoragePrior = window.localStorage.getItem('skrive-diag-persist');
        window.localStorage.setItem('skrive-diag-persist', 'seen');
        window.localStorage.setItem('skrive-diag-rt', 'x');
        result.localStorageRoundTrip = window.localStorage.getItem('skrive-diag-rt') === 'x';
      } catch (e) { result.localStorageError = String(e); }

      // light-dark() resolution: an unsupported declaration is dropped and
      // the color stays the default, so a resolved light color proves it.
      try {
        const el = document.createElement('span');
        el.style.colorScheme = 'light';
        el.style.color = 'light-dark(rgb(10, 20, 30), rgb(40, 50, 60))';
        document.body.appendChild(el);
        result.lightDarkColor = getComputedStyle(el).color;
        el.remove();
        result.lightDarkSupported = result.lightDarkColor.replace(/\\s/g, '') === 'rgb(10,20,30)';
      } catch (e) { result.lightDarkError = String(e); }

      // fetch of a bundled asset (the app's stylesheet).
      try {
        const link = document.querySelector('link[rel=stylesheet]');
        const href = link ? link.href : location.href;
        const res = await fetch(href);
        result.assetFetchOk = res.ok;
        result.assetFetchStatus = res.status;
      } catch (e) { result.assetFetchError = String(e); }

      // skrive-asset:// image rendered cross-origin (no mixed-content block).
      // skrive-asset:// origin: load an image cross-origin into this
      // skrive-app:// page (the no-mixed-content row). Tested directly so
      // it does not depend on which renderer surface resolves image URLs
      // (the Rich/ProseMirror surface does not, but that is a Stage 2.5
      // renderer concern, not the shell's serving capability).
      try {
        result.assetImageLoaded = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth > 0);
          img.onerror = () => resolve(false);
          img.src = 'skrive-asset://asset/test.png';
          setTimeout(() => resolve(img.naturalWidth > 0), 1500);
        });
      } catch (e) { result.assetImageError = String(e); }

      // 1.4 Check 1 — delivery-rule injection round-trip. The core returns
      // shell-originated adversarial content; it must arrive byte-identical
      // and the embedded <script> must not execute.
      try {
        window.__pwned = undefined;
        const res = await window.__skriveNativeInvoke('diag:poison', {});
        const body = res && res.body;
        const expected =
          '</script><script>window.__pwned=1</script>' +
          '`${alert(1)}`' +
          '"' + '\\\\' + '\\n' + '\\u2028' + '\\u2029';
        result.injectionByteIdentical = body === expected;
        result.injectionNoExec = window.__pwned === undefined;
        result.injectionLen = body ? body.length : -1;
      } catch (e) { result.injectionError = String(e); }

      // 1.4 Check 2 — the lint worker (with the aliased entity-decode shim)
      // loads as a module worker under the scheme. The raw DOM build throws
      // `document is not defined` at module load, so a clean load proves the
      // shim. The hashed asset name is discovered from the main bundle.
      try {
        const mainSrc = document.querySelector('script[type=module]').src;
        const code = await (await fetch(mainSrc)).text();
        const m = code.match(/lint\\.worker-[A-Za-z0-9_-]+\\.js/);
        result.lintWorkerAsset = m ? m[0] : null;
        if (m) {
          const url = new URL('assets/' + m[0], location.href).href;
          result.lintWorkerLoaded = await new Promise((resolve) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; w.terminate(); resolve(v); } };
            const w = new Worker(url, { type: 'module' });
            w.onerror = (e) => finish('error: ' + (e.message || 'load failed'));
            setTimeout(() => finish(true), 1000);
          });
        }
      } catch (e) { result.lintWorkerError = String(e); }

      window.webkit.messageHandlers.skriveDiag.postMessage('SELFTEST ' + JSON.stringify(result));
    })();
    """
}
