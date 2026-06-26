import './layers.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { perfEnabled } from './lib/perf';
import { installCrashLog } from './lib/crash-log';
import './index.css';
import './components/ui/tokens.css';

// Forward uncaught renderer errors to the host's local crash log. Installed
// before render so a crash during mount is still captured.
installCrashLog();

// Phase-12b cold-open marker. App.tsx reads this off window when the
// auto-opened project's manifest first becomes available, then logs
// the delta to give the writer a stable cold-open number.
if (perfEnabled) {
  (window as unknown as { __skriveMountStart?: number }).__skriveMountStart =
    performance.now();
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
