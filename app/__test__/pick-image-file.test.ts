// @vitest-environment jsdom
//
// The image picker's settlement rules. jsdom opens no file panel, so the tests
// drive the input's events directly — which is exactly the surface that matters
// here: the risk in this module is not the panel, it is a promise that settles
// twice, or never. A picker that never settles leaves the writer waiting on an
// image that is not coming, with nothing to show for the gesture.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickImageFile } from '../src/lib/pick-image-file';

/** The input pickImageFile just appended. It is the only file input in the
 *  document, and it removes itself once the promise settles. */
function pickerInput(): HTMLInputElement | null {
  return document.querySelector('input[type="file"]');
}

/** Put a file list on the input, since jsdom's `files` is not assignable. */
function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
}

function imageFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('input[type="file"]').forEach((el) => el.remove());
});

describe('pickImageFile', () => {
  it('resolves with the chosen file and cleans up its input', async () => {
    const pick = pickImageFile();
    const input = pickerInput()!;
    setFiles(input, [imageFile('shot.png', 'image/png')]);
    input.dispatchEvent(new Event('change'));

    const picked = await pick;
    expect(picked?.file.name).toBe('shot.png');
    expect(picked?.mimeType).toBe('image/png');
    expect(pickerInput()).toBeNull();
  });

  it('recovers the type from the filename when the browser reports none', async () => {
    const pick = pickImageFile();
    const input = pickerInput()!;
    setFiles(input, [imageFile('diagram.svg', '')]);
    input.dispatchEvent(new Event('change'));

    expect((await pick)?.mimeType).toBe('image/svg+xml');
  });

  it('resolves null on the cancel event', async () => {
    const pick = pickImageFile();
    pickerInput()!.dispatchEvent(new Event('cancel'));

    expect(await pick).toBeNull();
    expect(pickerInput()).toBeNull();
  });

  it('resolves null when focus returns and no choice follows', async () => {
    vi.useFakeTimers();
    const pick = pickImageFile();
    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();

    expect(await pick).toBeNull();
  });

  // The backstop must not outrun a real choice: `change` lands just after focus
  // returns, so a pick made from the panel has to win over the pending cancel.
  it('lets a choice arriving after focus beat the cancel backstop', async () => {
    vi.useFakeTimers();
    const pick = pickImageFile();
    const input = pickerInput()!;
    window.dispatchEvent(new Event('focus'));
    setFiles(input, [imageFile('late.png', 'image/png')]);
    input.dispatchEvent(new Event('change'));
    await vi.runAllTimersAsync();

    expect((await pick)?.file.name).toBe('late.png');
  });

  it('survives focus bouncing while the panel tears down', async () => {
    vi.useFakeTimers();
    const pick = pickImageFile();
    const input = pickerInput()!;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    setFiles(input, [imageFile('bounce.png', 'image/png')]);
    input.dispatchEvent(new Event('change'));
    await vi.runAllTimersAsync();

    expect((await pick)?.file.name).toBe('bounce.png');
  });

  // A chosen file that quietly does nothing is the failure this whole route
  // exists to avoid, so an unsupported type is an error, never a null "cancel".
  it('rejects an unsupported file rather than reporting a cancel', async () => {
    const pick = pickImageFile();
    const input = pickerInput()!;
    setFiles(input, [imageFile('scan.tiff', 'image/tiff')]);
    input.dispatchEvent(new Event('change'));

    await expect(pick).rejects.toThrow(/tiff/);
    expect(pickerInput()).toBeNull();
  });

  it('treats an empty selection as a cancel', async () => {
    const pick = pickImageFile();
    const input = pickerInput()!;
    setFiles(input, []);
    input.dispatchEvent(new Event('change'));

    expect(await pick).toBeNull();
  });
});
