import { describe, expect, it, vi } from 'vitest';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { connectPortToDefaultBrowser } from './connect-port';
import type { EnsureAgentBrowserSurfaceResult } from './use-dor-control';
import type { Surface as DorSurface } from 'dor/commands/types';

const URL = 'http://localhost:5173/';
const SESSION = sessionForKey('default');
const reference = { id: 'pane-1', ref: 'surface:1' } as DorSurface;

const okEnsure = (): EnsureAgentBrowserSurfaceResult =>
  ({ ok: true, status: 'created', surfaceId: 'pane-2', surfaceRef: 'surface:2', minimized: false });

// ensureSurface receives the reference as a lazy thunk; unwrap it so the
// call-shape assertions can compare plain values.
function ensureCallArgs(ensureSurface: ReturnType<typeof vi.fn>) {
  const [args] = ensureSurface.mock.calls.at(-1) ?? [];
  const { reference: lazyReference, ...rest } = args as { reference: () => { ok: boolean; value?: DorSurface } } & Record<string, unknown>;
  return { ...rest, reference: lazyReference().value };
}

describe('connectPortToDefaultBrowser', () => {
  it('opens the URL in the default session, reads the port, and ensures the surface', async () => {
    const ensureSurface = vi.fn(okEnsure);
    const platform = {
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      agentBrowserStreamStatus: vi.fn(async () => ({ ok: true, wsPort: 4321 })),
    };
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform, binaryPath: '/bin/ab', ensureSurface });

    expect(result).toEqual({ ok: true });
    expect(platform.agentBrowserCommand).toHaveBeenCalledWith(SESSION, ['open', URL], '/bin/ab');
    expect(platform.agentBrowserStreamStatus).toHaveBeenCalledWith(SESSION, '/bin/ab');
    expect(ensureCallArgs(ensureSurface)).toEqual({ key: 'default', session: SESSION, wsPort: 4321, binaryPath: '/bin/ab', reference });
  });

  it('fails when the host cannot run agent-browser', async () => {
    const ensureSurface = vi.fn(okEnsure);
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform: {}, ensureSurface });
    expect(result).toEqual({ ok: false, message: 'opening a browser surface is not supported on this host' });
    expect(ensureSurface).not.toHaveBeenCalled();
  });

  it('surfaces trimmed stderr on a non-zero exit', async () => {
    const ensureSurface = vi.fn(okEnsure);
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 3, stdout: '', stderr: '  boom  \n' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform, ensureSurface });
    expect(result).toEqual({ ok: false, message: 'boom' });
    expect(ensureSurface).not.toHaveBeenCalled();
  });

  it('reports the exit code when a non-zero exit has no stderr', async () => {
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 3, stdout: '', stderr: '' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform, ensureSurface: vi.fn(okEnsure) });
    expect(result).toEqual({ ok: false, message: 'agent-browser open exited 3' });
  });

  it('leaves wsPort undefined when the host has no stream-status channel', async () => {
    const ensureSurface = vi.fn(okEnsure);
    const platform = { agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform, ensureSurface });
    expect(result).toEqual({ ok: true });
    expect(ensureCallArgs(ensureSurface)).toEqual({ key: 'default', session: SESSION, wsPort: undefined, binaryPath: undefined, reference });
  });

  it('leaves wsPort undefined when stream status fails', async () => {
    const ensureSurface = vi.fn(okEnsure);
    const platform = {
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      agentBrowserStreamStatus: vi.fn(async () => ({ ok: false, error: 'nope' })),
    };
    await connectPortToDefaultBrowser({ url: URL, reference, platform, binaryPath: '/bin/ab', ensureSurface });
    expect(ensureCallArgs(ensureSurface)).toEqual({ key: 'default', session: SESSION, wsPort: undefined, binaryPath: '/bin/ab', reference });
  });

  it('propagates an ensureSurface failure', async () => {
    const ensureSurface = vi.fn((): EnsureAgentBrowserSurfaceResult => ({ ok: false, message: 'no room' }));
    const platform = {
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      agentBrowserStreamStatus: vi.fn(async () => ({ ok: true, wsPort: 4321 })),
    };
    const result = await connectPortToDefaultBrowser({ url: URL, reference, platform, ensureSurface });
    expect(result).toEqual({ ok: false, message: 'no room' });
  });
});
