import { useEffect, useState } from 'react';

export function App() {
  const [version, setVersion] = useState<string>('…');
  const [platform, setPlatform] = useState<string>('…');

  useEffect(() => {
    void window.skrive.app.version().then(setVersion);
    void window.skrive.app.platform().then(setPlatform);
  }, []);

  return (
    <main className="shell">
      <div className="shell__brand">Skrive</div>
      <div className="shell__meta">
        <span>v{version}</span>
        <span>·</span>
        <span>{platform}</span>
      </div>
      <p className="shell__status">React + Electron foundation. Phase 1.</p>
    </main>
  );
}
