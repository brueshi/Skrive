// Pure paste-image helpers: extension mapping, asset placement, filename,
// link construction, and base64 encoding. The clipboard picking (surface.ts)
// and the IPC write (stores/project.ts, `pasteImageAsset`) are DOM/IO-coupled
// and covered by the blocksurface paste-image suite + hand verification.

import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  imageExtension,
  imageMarkdownLink,
  imagePasteTarget,
  pastedImageFilename
} from '../../src/lib/clipboard/pasteImage';

describe('imageExtension', () => {
  it('maps known image MIME types to extensions', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(imageExtension('image/svg+xml')).toBe('svg');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(imageExtension('IMAGE/PNG')).toBe('png');
    expect(imageExtension('  image/png  ')).toBe('png');
  });

  it('returns null for non-image or unknown types', () => {
    expect(imageExtension('text/plain')).toBeNull();
    expect(imageExtension('application/pdf')).toBeNull();
    expect(imageExtension('')).toBeNull();
  });
});

describe('imagePasteTarget', () => {
  it('places the asset in a sibling folder for a nested document', () => {
    const target = imagePasteTarget('docs/notes.md', 'pasted-image-42.png');
    expect(target.writePath).toBe('docs/assets/pasted-image-42.png');
    expect(target.linkPath).toBe('assets/pasted-image-42.png');
  });

  it('handles a root-level document', () => {
    const target = imagePasteTarget('notes.md', 'pasted-image-42.png');
    expect(target.writePath).toBe('assets/pasted-image-42.png');
    expect(target.linkPath).toBe('assets/pasted-image-42.png');
  });

  it('keeps the link relative to the document regardless of depth', () => {
    const target = imagePasteTarget('a/b/c/deep.md', 'pasted-image-42.png');
    expect(target.writePath).toBe('a/b/c/assets/pasted-image-42.png');
    expect(target.linkPath).toBe('assets/pasted-image-42.png');
  });
});

describe('pastedImageFilename', () => {
  it('builds a space-free timestamped name with the given extension', () => {
    expect(pastedImageFilename('png', 1712345678901)).toBe(
      'pasted-image-1712345678901.png'
    );
    expect(pastedImageFilename('jpg', 1712345678901)).not.toContain(' ');
  });
});

describe('imageMarkdownLink', () => {
  it('wraps the link path in image syntax with empty alt', () => {
    expect(imageMarkdownLink('assets/pasted-image-42.png')).toBe(
      '![](assets/pasted-image-42.png)'
    );
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes the same way btoa would for a short buffer', () => {
    const bytes = new Uint8Array([0x68, 0x69]); // "hi"
    expect(bytesToBase64(bytes)).toBe(btoa('hi'));
  });

  it('handles an empty buffer', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('round-trips a buffer larger than the chunk size', () => {
    const bytes = new Uint8Array(0x8000 + 10).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
