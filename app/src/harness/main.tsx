// Latency-harness entry (SKR-108, Stage 0). Dev-only.
//
// Mounts the bespoke block surface over a deterministic adversarial document,
// then publishes the gate's instrumentation on `window` for the Playwright
// matrix to drive and read. This deliberately isolates the editor *surface*: no
// native bridge, no project store, no cold-path noise — exactly the hot path the
// gate measures (planning/editor-surface-build-plan.md, "The latency
// architecture"). The retired Rich (ProseMirror) / Text (CodeMirror) rows were
// dropped at the cutover (SKR-111) along with those engines; the bespoke
// `surface=block` row is the post-cutover gate (harness/block.matrix.spec.ts).
//
// Query params:
//   surface = block | bespoke-single | bespoke-perblock   (default block)
//   blocks  = <int>              content blocks in the corpus (default 200)
//   anchors = <int>              anchor comment every Nth block, 0 = none (default 0)
//   seed    = <int>              corpus PRNG seed (default 0xc0ffee)

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mountBespoke, type BespokeVariant } from './bespoke/surface';
import { BlockSurface } from '../lib/blocksurface';
import { BlockMenuController } from '../components/editor/menus/BlockMenuController';
import { SelectionBubble } from '../components/editor/menus/SelectionBubble';
import { LinkEditor } from '../components/editor/menus/LinkEditor';
import { BlockSlashMenu } from '../components/editor/menus/BlockSlashMenu';
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

type SurfaceId = 'bespoke-single' | 'bespoke-perblock' | 'block';

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
    raw === 'bespoke-single' || raw === 'bespoke-perblock' ? raw : 'block';
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
      ) : (
        <BlockSurfaceMount body={body} />
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
      // The command paths a menu drives, callable after the matrix clears the live
      // selection — the WKWebView blurred-selection simulation (SKR-173 / SKR-151).
      setBlockType(spec: { kind: 'paragraph' } | { kind: 'heading'; level: number }): void;
      toggleList(target: 'bullet_list' | 'ordered_list'): void;
      beginLink(): boolean;
      commitLink(href: string): void;
      cancelLink(): void;
    };
  }
}
function BlockSurfaceMount({ body }: { body: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<{ surface: BlockSurface; controller: BlockMenuController } | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const doc: BlockDocument = parseDocument(body);
    const s = new BlockSurface({ container: ref.current, doc });
    const controller = new BlockMenuController(s);
    setCtx({ surface: s, controller });
    window.__skriveBlockSurface = {
      serialize: () => serializeDocument(s.getDocument()),
      blockCount: () => s.getDocument().blocks.length,
      setBlockType: (spec) => s.setBlockType(spec),
      toggleList: (target) => s.toggleList(target),
      beginLink: () => s.beginLink(),
      commitLink: (href) => s.commitLink(href),
      cancelLink: () => s.cancelLink()
    };
    return () => {
      controller.destroy();
      s.destroy();
      setCtx(null);
      delete window.__skriveBlockSurface;
    };
  }, [body]);
  return (
    <>
      <div ref={ref} className="bespoke-root" />
      {ctx && <SelectionBubble controller={ctx.controller} />}
      {ctx && <LinkEditor controller={ctx.controller} />}
      {ctx && <BlockSlashMenu surface={ctx.surface} />}
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
