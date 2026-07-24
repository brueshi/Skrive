// The per-document line-measure override: one key per format (folio
// docMeta / md frontmatter), read leniently (invalid values fall back to
// the global default, never rewritten), persisted through the existing
// save builders with no save-path changes.

import { beforeEach, describe, expect, it } from 'vitest';
import { parseLineMeasure } from '@skrive/shared';
import {
  selectLiveDocLineMeasure,
  useProjectStore,
  type LiveDoc
} from '../../src/stores/project';
import { buildMarkdownPayload } from '../../src/stores/save/markdown-save';
import { usePreferencesStore } from '../../src/stores/preferences';
import { buildFolioPayload } from '../../src/stores/save/folio-save';
import { folioToModel, parseFolio } from '../../src/lib/folio';
import { richFixture } from '../folio/fixture';

function markdownDoc(frontmatter: Record<string, unknown> = {}): LiveDoc {
  return {
    path: 'notes/a.md',
    mode: 'markdown',
    frontmatter,
    dirty: false
  } as unknown as LiveDoc;
}

function richDoc(docMeta: Record<string, unknown>): LiveDoc {
  return {
    path: 'notes/a.folio',
    mode: 'rich',
    frontmatter: {},
    docMeta: { title: null, createdAt: '2026-01-01T00:00:00.000Z', ...docMeta },
    dirty: false
  } as unknown as LiveDoc;
}

beforeEach(() => {
  useProjectStore.setState({ liveDoc: null });
});

describe('parseLineMeasure', () => {
  it('accepts the four presets and rejects everything else', () => {
    expect(parseLineMeasure('narrow')).toBe('narrow');
    expect(parseLineMeasure('full')).toBe('full');
    expect(parseLineMeasure('FULL')).toBeNull();
    expect(parseLineMeasure(42)).toBeNull();
    expect(parseLineMeasure(undefined)).toBeNull();
    expect(parseLineMeasure(null)).toBeNull();
  });
});

describe('setLiveDocLineMeasure on a markdown doc', () => {
  it('writes and clears the frontmatter key, marking dirty', () => {
    useProjectStore.setState({ liveDoc: markdownDoc() });
    useProjectStore.getState().setLiveDocLineMeasure('wide');
    let doc = useProjectStore.getState().liveDoc!;
    expect(doc.frontmatter.line_measure).toBe('wide');
    expect(doc.dirty).toBe(true);

    useProjectStore.getState().setLiveDocLineMeasure(null);
    doc = useProjectStore.getState().liveDoc!;
    expect('line_measure' in doc.frontmatter).toBe(false);
  });

  it('no-ops when the value is unchanged (stays clean)', () => {
    useProjectStore.setState({ liveDoc: markdownDoc() });
    useProjectStore.getState().setLiveDocLineMeasure(null);
    expect(useProjectStore.getState().liveDoc!.dirty).toBe(false);

    useProjectStore.setState({
      liveDoc: markdownDoc({ line_measure: 'wide' })
    });
    useProjectStore.getState().setLiveDocLineMeasure('wide');
    expect(useProjectStore.getState().liveDoc!.dirty).toBe(false);
  });
});

describe('setLiveDocLineMeasure on a rich doc', () => {
  it('writes and clears the docMeta key, marking dirty', () => {
    useProjectStore.setState({ liveDoc: richDoc({}) });
    useProjectStore.getState().setLiveDocLineMeasure('narrow');
    let doc = useProjectStore.getState().liveDoc!;
    expect(doc.docMeta?.lineMeasure).toBe('narrow');
    expect(doc.dirty).toBe(true);

    useProjectStore.getState().setLiveDocLineMeasure(null);
    doc = useProjectStore.getState().liveDoc!;
    expect(doc.docMeta && 'lineMeasure' in doc.docMeta).toBe(false);
  });
});

describe('setLiveDocLineMeasure on a text doc', () => {
  it('no-ops — no override home', () => {
    const doc = {
      path: 'a.txt',
      mode: 'text',
      frontmatter: {},
      dirty: false
    } as unknown as LiveDoc;
    useProjectStore.setState({ liveDoc: doc });
    useProjectStore.getState().setLiveDocLineMeasure('wide');
    expect(useProjectStore.getState().liveDoc!.dirty).toBe(false);
  });
});

describe('selectLiveDocLineMeasure', () => {
  it('reads the right home per mode and ignores invalid values', () => {
    useProjectStore.setState({
      liveDoc: markdownDoc({ line_measure: 'narrow' })
    });
    expect(selectLiveDocLineMeasure(useProjectStore.getState())).toBe(
      'narrow'
    );

    useProjectStore.setState({ liveDoc: richDoc({ lineMeasure: 'full' }) });
    expect(selectLiveDocLineMeasure(useProjectStore.getState())).toBe('full');

    useProjectStore.setState({
      liveDoc: markdownDoc({ line_measure: 'zen' })
    });
    expect(selectLiveDocLineMeasure(useProjectStore.getState())).toBeNull();
  });
});

describe('the override persists through the save builders', () => {
  it('markdown: line_measure rides the frontmatter fence', () => {
    usePreferencesStore.setState({ formatOnSave: false });
    const out = buildMarkdownPayload({
      body: 'hello\n',
      frontmatter: { line_measure: 'wide' }
    });
    expect(out).toContain('line_measure: wide');
    expect(out.endsWith('hello\n')).toBe(true);
  });

  it('folio: docMeta.lineMeasure round-trips serialize -> parse', () => {
    const out = buildFolioPayload({
      model: folioToModel(richFixture),
      docId: richFixture.docId,
      docMeta: { ...richFixture.docMeta, lineMeasure: 'narrow' }
    });
    expect(parseFolio(out).docMeta.lineMeasure).toBe('narrow');
  });
});
