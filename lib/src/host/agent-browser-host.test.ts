import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBrowserHost } from './agent-browser-host';

type SpawnResult = { stdout?: string; stderr?: string; code?: number };

const spawnMock = vi.hoisted(() => vi.fn());

// The host spawns through dor-lib-common's spawnAndCapture; mock that boundary,
// not its internal cross-spawn (spawnAndCapture's own behavior is covered by
// dor-lib-common's tests).
vi.mock('dor-lib-common', () => ({
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
