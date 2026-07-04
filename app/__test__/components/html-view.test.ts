// HTML viewer (SKR-205): the srcdoc builder that injects the sandbox CSP. The
// iframe's empty `sandbox` is the real security boundary, but the CSP is the
// documented-intent layer, so verify it lands in `<head>` for every input shape
// and denies scripts while permitting remote resource loads.

import { describe, expect, it } from 'vitest';
import { buildViewerDocument } from '../../src/components/editor/html/HtmlView';

const CSP_META = /<meta http-equiv="Content-Security-Policy"/i;

describe('buildViewerDocument', () => {
  it('injects the CSP as the first child of an existing <head>', () => {
    const doc = buildViewerDocument(
      '<!DOCTYPE html><html><head><title>T</title></head><body>hi</body></html>'
    );
    expect(doc).toMatch(CSP_META);
    // Injected immediately after the head open, before the title.
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<title>'));
  });

  it('creates a <head> when the document has <html> but none', () => {
    const doc = buildViewerDocument('<html><body>hi</body></html>');
    expect(doc).toMatch(CSP_META);
    expect(doc).toMatch(/<html><head><meta http-equiv="Content-Security-Policy"[^>]*><\/head><body>/i);
  });

  it('wraps a bare fragment in a full document with the CSP', () => {
    const doc = buildViewerDocument('<p>just a fragment</p>');
    expect(doc).toMatch(/^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/i);
    expect(doc).toContain('<body><p>just a fragment</p></body>');
  });

  it('denies scripts and plugins but allows remote resource loads', () => {
    const doc = buildViewerDocument('<p>x</p>');
    const csp = doc.match(/content="([^"]*)"/)![1];
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("object-src 'none'");
    // Remote images/styles/fonts are permitted (product decision): default-src
    // carries http/https so a saved page renders faithfully.
    expect(csp).toMatch(/default-src[^;]*https:/);
    expect(csp).toMatch(/default-src[^;]*http:/);
  });

  it('is case-insensitive about the head tag', () => {
    const doc = buildViewerDocument('<HTML><HEAD></HEAD><BODY>hi</BODY></HTML>');
    // Injected into the existing (uppercase) head, not by wrapping a fresh one.
    expect((doc.match(/<head/gi) ?? []).length).toBe(1);
    expect(doc).toMatch(CSP_META);
  });
});
