// Latency-harness entry (SKR-108, Stage 0). Dev-only.
//
// Mounts a single editor surface — today's Rich (ProseMirror) or Text
// (CodeMirror) — over a deterministic adversarial document, then publishes the
// gate's instrumentation on `window` for the Playwright matrix to drive and
// read. This deliberately isolates the editor *surface*: no native bridge, no
// project store, no cold-path noise — exactly the hot path the gate measures
// (planning/editor-surface-build-plan.md, "The latency architecture"). When the
// bespoke surface arrives, it mounts here behind the same contract and every
// matrix row applies unchanged.
//
// Query params:
//   surface = rich | text        (default rich)
//   blocks  = <int>              content blocks in the corpus (default 200)
//   anchors = <int>              anchor comment every Nth block, 0 = none (default 0)
//   seed    = <int>              corpus PRNG seed (default 0xc0ffee)

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichEditor } from '../components/editor/rich/RichEditor';
import { Editor } from '../components/editor/Editor';
import { mountBespoke, type BespokeVariant } from './bespoke/surface';
import { BlockSurface, SelectionBubble, SlashMenu } from '../lib/blocksurface';
import { parseDocument, serializeDocument, type Document as BlockDocument } from '../lib/blockmodel';
import {
  buildAdversarialDoc,
  enableLatencyProbe,
  LatencyOverlay,
  FIRST_BLOCK_MARKER,
  LAST_BLOCK_MARKER,
  ANCHORED_BLOCK_MARKER
} from '../lib/instrumentation';
import '../index.css';
import './harness.css';

type SurfaceId = 'rich' | 'text' | 'bespoke-single' | 'bespoke-perblock' | 'block';

type HarnessApi = {
  surface: SurfaceId;
  blockCount: number;
  anchorCount: number;
  markers: { first: string; last: string; anchored: string };
  ready: boolean;
  /** Toggle a main-thread contention proxy for the cold path. The gate's hard
   *  claim is that the hot path stays constant-time *while the cold path churns*;
   *  this steals frame time on a fixed cadence so the matrix can prove the glyph
   *  still lands on time under load. The real worker cold path (serialize / lint)
   *  replaces this proxy as it lands in later stages. */
  setColdLoad(on: boolean): void;
};

declare global {
  interface Window {
    __skriveHarness?: HarnessApi;
  }
}

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const raw = q.get('surface');
  const surface: SurfaceId =
    raw === 'text' || raw === 'bespoke-single' || raw === 'bespoke-perblock' || raw === 'block' ? raw : 'rich';
  const blocks = Math.max(1, Number(q.get('blocks') ?? '200') | 0);
  const anchorEvery = Math.max(0, Number(q.get('anchors') ?? '0') | 0);
  const seed = q.get('seed') ? Number(q.get('seed')) | 0 : undefined;
  return { surface, blocks, anchorEvery, seed };
}

// Cold-path contention proxy. A bounded synchronous burst on a fixed cadence —
// enough to steal frames without wedging the tab — so "type while the cold path
// runs" is a real, repeatable matrix condition.
const COLD_BURST_MS = 6;
const COLD_CADENCE_MS = 16;
let coldTimer: number | null = null;
function setColdLoad(on: boolean): void {
  if (on && coldTimer === null) {
    coldTimer = window.setInterval(() => {
      const end = performance.now() + COLD_BURST_MS;
      // Side-effecting busy work the optimiser cannot elide.
      let acc = 0;
      while (performance.now() < end) acc += Math.sqrt(acc + 1);
      (window as unknown as { __coldAcc?: number }).__coldAcc = acc;
    }, COLD_CADENCE_MS);
  } else if (!on && coldTimer !== null) {
    window.clearInterval(coldTimer);
    coldTimer = null;
  }
}

// Minimal, defensive native-bridge stub. The editor surface never calls into it
// at mount or while typing (skrive.fs / skrive.links are on-demand: binary paste
// and external-link clicks), but stubbing keeps an accidental call from throwing
// and aborting a matrix run.
function installSkriveStub(): void {
  if ((window as unknown as { skrive?: unknown }).skrive) return;
  const noop = async () => undefined;
  (window as unknown as { skrive: unknown }).skrive = {
    fs: { writeBinaryFile: noop, readFile: noop },
    links: { openExternal: noop },
    persistence: { load: noop, save: noop }
  };
}

function Harness({ surface, body }: { surface: SurfaceId; body: string }) {
  useEffect(() => {
    // Mark ready a frame after mount so Playwright waits for a painted surface.
    const id = requestAnimationFrame(() => {
      if (window.__skriveHarness) window.__skriveHarness.ready = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const bespokeVariant: BespokeVariant | null =
    surface === 'bespoke-single' ? 'single' : surface === 'bespoke-perblock' ? 'perblock' : null;

  return (
    <div className="harness-surface">
      {bespokeVariant ? (
        <BespokeMount body={body} variant={bespokeVariant} />
      ) : surface === 'block' ? (
        <BlockSurfaceMount body={body} />
      ) : surface === 'rich' ? (
        <RichEditor body={body} onChange={() => {}} />
      ) : (
        <Editor value={body} onChange={() => {}} filePath={null} projectRoot="" lintFindings={[]} />
      )}
      <LatencyOverlay />
    </div>
  );
}

// Mounts the framework-free spike imperatively. React only does the initial mount;
// the keystroke hot path runs in plain DOM, never through React.
function BespokeMount({ body, variant }: { body: string; variant: BespokeVariant }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) mountBespoke(ref.current, body, variant);
  }, [body, variant]);
  return <div ref={ref} className="bespoke-root" />;
}

// Mounts the real Stage 3 surface. Exposes it on window so the matrix can read
// the serialized Markdown back for the fidelity check.
declare global {
  interface Window {
    __skriveBlockSurface?: {
      serialize(): string;
      blockCount(): number;
    };
  }
}
function BlockSurfaceMount({ body }: { body: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<BlockSurface | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const doc: BlockDocument = parseDocument(body);
    const s = new BlockSurface({ container: ref.current, doc });
    setSurface(s);
    window.__skriveBlockSurface = {
      serialize: () => serializeDocument(s.getDocument()),
      blockCount: () => s.getDocument().blocks.length
    };
    return () => {
      s.destroy();
      setSurface(null);
      delete window.__skriveBlockSurface;
    };
  }, [body]);
  return (
    <>
      <div ref={ref} className="bespoke-root" />
      {surface && <SelectionBubble surface={surface} />}
      {surface && <SlashMenu surface={surface} />}
    </>
  );
}

function main(): void {
  const { surface, blocks, anchorEvery, seed } = readParams();
  installSkriveStub();
  const doc = buildAdversarialDoc({ blocks, anchorEvery, seed });

  enableLatencyProbe(document);
  window.__skriveHarness = {
    surface,
    blockCount: doc.blockCount,
    anchorCount: doc.anchorCount,
    markers: { first: FIRST_BLOCK_MARKER, last: LAST_BLOCK_MARKER, anchored: ANCHORED_BLOCK_MARKER },
    ready: false,
    setColdLoad
  };

  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('Missing #root element in harness.html');
  createRoot(rootEl).render(
    <StrictMode>
      <Harness surface={surface} body={doc.markdown} />
    </StrictMode>
  );
}

main();
