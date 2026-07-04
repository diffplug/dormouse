import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBrowserHost } from './agent-browser-host';

type SpawnResult = { stdout?: string; stderr?: string; code?: number };

const spawnMock = vi.hoisted(() => vi.fn());

// The host spawns through dor-lib-common's spawnAndCapture; mock just that
// boundary (not its internal cross-spawn — spawnAndCapture's own behavior is
// covered by dor-lib-common's tests), keeping the package's other real exports
// (e.g. parseStreamPort).
vi.mock('dor-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dor-lib-common')>()),
  spawnAndCapture: spawnMock,
}));

function enqueueSpawnResults(results: SpawnResult[]) {
  const queue = [...results];
  spawnMock.mockImplementation((binary: string, args: string[]) => {
    const result = queue.shift();
    if (!result) throw new Error(`unexpected spawn: ${binary} ${args.join(' ')}`);
    return Promise.resolve({
      ok: true as const,
      exitCode: result.code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  });
}

describe('agent-browser host relaunch', () => {
  const originalSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;

  beforeEach(() => {
    spawnMock.mockReset();
    process.env.AGENT_BROWSER_SOCKET_DIR = mkdtempSync(join(tmpdir(), 'dormouse-ab-host-test-'));
  });

  afterEach(() => {
    if (originalSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = originalSocketDir;
  });

  it('closes a stray about:blank tab when tab list reports CLI-style id fields', async () => {
    enqueueSpawnResults([
      {}, // close
      {}, // --headed open
      {
        stdout: JSON.stringify({
          tabs: [
            { id: 'blank-tab', url: 'about:blank', active: false },
            { id: 'real-tab', url: 'https://example.com/', active: true },
          ],
        }),
      },
      {}, // tab close blank-tab
      { stdout: JSON.stringify({ port: 61218 }) },
    ]);

    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const result = await host.popOut('dormouse.1.default', { url: 'https://example.com/' }, '/usr/local/bin/agent-browser');

    expect(result).toEqual({ ok: true, wsPort: 61218 });
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/agent-browser',
      ['--session', 'dormouse.1.default', 'tab', 'close', 'blank-tab'],
    );
  });
});

describe('agent-browser host screenshot transport', () => {
  // Block body (not `() => spawnMock.mockReset()`): an arrow returning the mock
  // makes vitest register it as a teardown hook and call it — a phantom spawn.
  beforeEach(() => { spawnMock.mockReset(); });

  it('screenshotToFile returns the path + mime without reading the bytes', async () => {
    const shotPath = join(tmpdir(), 'dormouse-ab-shot-shotfile.jpg');
    rmSync(shotPath, { force: true }); // no capture ran, so no file should exist
    // Only the CLI spawn happens — no file is written by the mock.
    enqueueSpawnResults([{}]); // screenshot exits 0

    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const result = await host.screenshotToFile('shotfile', { format: 'jpeg', quality: 85 }, '/usr/local/bin/agent-browser');

    expect(result).toEqual({ ok: true, path: shotPath, mime: 'image/jpeg' });
    // The capture never touched the filesystem: the path points at a file that
    // does not exist (the mock spawned nothing that would create it).
    expect(existsSync(shotPath)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/agent-browser', [
      '--session', 'shotfile', 'screenshot', shotPath,
      '--screenshot-format', 'jpeg', '--screenshot-quality', '85',
    ]);
  });

  it('screenshot() still reads the file and returns the raw bytes', async () => {
    const shotPath = join(tmpdir(), 'dormouse-ab-shot-shotbytes.jpg');
    const payload = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
    writeFileSync(shotPath, payload); // stand in for agent-browser writing the frame
    enqueueSpawnResults([{}]); // screenshot exits 0

    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const result = await host.screenshot('shotbytes', { format: 'jpeg', quality: 85 }, '/usr/local/bin/agent-browser');

    expect(result.ok).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(Array.from(result.bytes ?? [])).toEqual(Array.from(payload));
    rmSync(shotPath, { force: true });
  });
});
