import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
  readClipboardImageAsFilePath: vi.fn<() => Promise<string | null>>(),
  writePty: vi.fn<(id: string, data: string) => void>(),
  readText: vi.fn<() => Promise<string>>(),
  shellKind: 'posix' as 'cmd' | 'posix' | 'powershell',
}));

vi.mock('./platform', () => ({
  IS_MAC: false,
  IS_WINDOWS: false,
  PLATFORM_STRING: 'Linux',
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
  // Deliberately posix: the Session-specific value must win over this current
  // default when the regression case changes shellKind to PowerShell.
  getDefaultShellOpts: () => ({ shell: '/bin/bash' }),
  getTerminalShellKind: () => mocks.shellKind,
  getTerminalInstance: () => null,
  markSessionTouched: vi.fn(),
}));

import { doPaste } from './clipboard';

describe('doPaste three-tier fallthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shellKind = 'posix';
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

  it("uses the target Session's shell after the app default changes", async () => {
    mocks.shellKind = 'powershell';
    mocks.readClipboardFilePaths.mockResolvedValue(['C:\\Users\\me\\$(calc.exe).txt']);
    mocks.readText.mockResolvedValue('coexisting text payload');

    await doPaste('powershell-session');

    expect(mocks.writePty).toHaveBeenCalledWith(
      'powershell-session',
      "'C:\\Users\\me\\$(calc.exe).txt' ",
    );
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
