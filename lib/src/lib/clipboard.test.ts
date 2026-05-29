import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
  readClipboardImageAsFilePath: vi.fn<() => Promise<string | null>>(),
  writePty: vi.fn<(id: string, data: string) => void>(),
  readText: vi.fn<() => Promise<string>>(),
}));

vi.mock('./platform', () => ({
  IS_MAC: false,
  IS_WINDOWS: false,
  getPlatform: () => ({
    readClipboardFilePaths: mocks.readClipboardFilePaths,
    readClipboardImageAsFilePath: mocks.readClipboardImageAsFilePath,
    writePty: mocks.writePty,
  }),
}));

vi.mock('./mouse-selection', () => ({
  getMouseSelectionState: () => ({ bracketedPaste: false }),
}));

vi.mock('./terminal-registry', () => ({
  getTerminalInstance: () => null,
  markSessionTouched: vi.fn(),
}));

import { doPaste } from './clipboard';

describe('doPaste three-tier fallthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { readText: mocks.readText } },
      configurable: true,
    });
  });

  it('prefers file refs over text and skips the image read', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(['/tmp/a.png', '/tmp/b file.png']);
    mocks.readText.mockResolvedValue('coexisting text payload');
    mocks.readClipboardImageAsFilePath.mockResolvedValue('/tmp/img.png');

    await doPaste('t1');

    expect(mocks.readClipboardImageAsFilePath).not.toHaveBeenCalled();
    expect(mocks.writePty).toHaveBeenCalledTimes(1);
    expect(mocks.writePty).toHaveBeenCalledWith('t1', '/tmp/a.png /tmp/b\\ file.png ');
  });

  it('falls through to text when no file refs', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('hello world');
    mocks.readClipboardImageAsFilePath.mockResolvedValue('/tmp/img.png');

    await doPaste('t1');

    expect(mocks.readClipboardImageAsFilePath).not.toHaveBeenCalled();
    expect(mocks.writePty).toHaveBeenCalledWith('t1', 'hello world');
  });

  it('falls through to image when no files and no text', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue([]);
    mocks.readText.mockResolvedValue('');
    mocks.readClipboardImageAsFilePath.mockResolvedValue('/tmp/img.png');

    await doPaste('t1');

    expect(mocks.writePty).toHaveBeenCalledWith('t1', '/tmp/img.png ');
  });

  it('is a no-op when all tiers come back empty', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('');
    mocks.readClipboardImageAsFilePath.mockResolvedValue(null);

    await doPaste('t1');

    expect(mocks.writePty).not.toHaveBeenCalled();
  });

  it('swallows file-ref adapter errors and falls through to text', async () => {
    mocks.readClipboardFilePaths.mockRejectedValue(new Error('boom'));
    mocks.readText.mockResolvedValue('fallback');

    await doPaste('t1');

    expect(mocks.writePty).toHaveBeenCalledWith('t1', 'fallback');
  });

  it('swallows image adapter errors silently', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('');
    mocks.readClipboardImageAsFilePath.mockRejectedValue(new Error('boom'));

    await doPaste('t1');

    expect(mocks.writePty).not.toHaveBeenCalled();
  });
});
