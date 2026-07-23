import { describe, expect, it, vi } from 'vitest';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { connectPortToDefaultBrowser } from './connect-port';

const URL = 'http://localhost:5173/';
const SESSION = sessionForKey('default');

// The eager surface is created before the daemon boots; a plain ok result stands
// in for the real reuse-or-create seam.
const okEager = () => ({ ok: true as const, value: { surfaceId: 'pane-2' } });

describe('connectPortToDefaultBrowser', () => {
  it('creates the eager surface before opening, reads the port, then refreshes with session/wsPort/binaryPath', async () => {
    const calls: string[] = [];
    const ensureEagerSurface = vi.fn(() => { calls.push('ensure'); return okEager(); });
    const refreshSurface = vi.fn();
    const platform = {
      agentBrowserCommand: vi.fn(async () => { calls.push('open'); return { exitCode: 0, stdout: '', stderr: '' }; }),
      agentBrowserStreamStatus: vi.fn(async () => ({ ok: true, wsPort: 4321 })),
    };
    const result = await connectPortToDefaultBrowser({ url: URL, platform, binaryPath: '/bin/ab', ensureEagerSurface, refreshSurface });

    expect(result).toEqual({ ok: true });
    // The pane is created (session-less) before the slow daemon boot.
    expect(calls).toEqual(['ensure', 'open']);
    expect(ensureEagerSurface).toHaveBeenCalledWith(SESSION);
    expect(platform.agentBrowserCommand).toHaveBeenCalledWith(SESSION, ['open', URL], '/bin/ab');
    expect(platform.agentBrowserStreamStatus).toHaveBeenCalledWith(SESSION, '/bin/ab');
    expect(refreshSurface).toHaveBeenCalledTimes(1);
    expect(refreshSurface).toHaveBeenCalledWith('pane-2', { session: SESSION, wsPort: 4321, binaryPath: '/bin/ab' });
  });

  it('short-circuits before creating a surface when the host cannot run agent-browser', async () => {
    const ensureEagerSurface = vi.fn(okEager);
    const refreshSurface = vi.fn();
    const result = await connectPortToDefaultBrowser({ url: URL, platform: {}, ensureEagerSurface, refreshSurface });
    expect(result).toEqual({ ok: false, message: 'opening a browser surface is not supported on this host' });
    expect(ensureEagerSurface).not.toHaveBeenCalled();
    expect(refreshSurface).not.toHaveBeenCalled();
  });

  it('propagates an ensureEagerSurface failure without opening', async () => {
    const ensureEagerSurface = vi.fn(() => ({ ok: false as const, message: 'no room' }));
    const refreshSurface = vi.fn();
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, platform, ensureEagerSurface, refreshSurface });
    expect(result).toEqual({ ok: false, message: 'no room' });
    expect(platform.agentBrowserCommand).not.toHaveBeenCalled();
    expect(refreshSurface).not.toHaveBeenCalled();
  });

  it('keeps the pane (refreshing just the session) and surfaces trimmed stderr on a non-zero exit', async () => {
    const ensureEagerSurface = vi.fn(okEager);
    const refreshSurface = vi.fn();
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 3, stdout: '', stderr: '  boom  \n' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, platform, ensureEagerSurface, refreshSurface });
    expect(result).toEqual({ ok: false, message: 'boom' });
    // The pane stays; the session lets its placeholder name the session.
    expect(refreshSurface).toHaveBeenCalledWith('pane-2', { session: SESSION });
  });

  it('reports the exit code when a non-zero exit has no stderr', async () => {
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 3, stdout: '', stderr: '' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, platform, ensureEagerSurface: vi.fn(okEager), refreshSurface: vi.fn() });
    expect(result).toEqual({ ok: false, message: 'agent-browser open exited 3' });
  });

  it('omits wsPort in the refresh when the host has no stream-status channel', async () => {
    const refreshSurface = vi.fn();
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, platform, ensureEagerSurface: vi.fn(okEager), refreshSurface });
    expect(result).toEqual({ ok: true });
    expect(refreshSurface).toHaveBeenCalledWith('pane-2', { session: SESSION });
  });

  it('omits wsPort in the refresh when stream status fails', async () => {
    const refreshSurface = vi.fn();
    const platform = {
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      agentBrowserStreamStatus: vi.fn(async () => ({ ok: false, error: 'nope' })),
    };
    await connectPortToDefaultBrowser({ url: URL, platform, binaryPath: '/bin/ab', ensureEagerSurface: vi.fn(okEager), refreshSurface });
    expect(refreshSurface).toHaveBeenCalledWith('pane-2', { session: SESSION, binaryPath: '/bin/ab' });
  });
});
