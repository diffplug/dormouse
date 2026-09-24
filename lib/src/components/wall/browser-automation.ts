/** Provider adaptation beneath the shared automated-browser viewer. */
import { getPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import type { BrowserAutomationProvider, PlaywrightRequest } from '../../lib/platform/browser-automation';
import type { RenderMode } from './agent-browser-screen';
export function automationProvider(mode: unknown): BrowserAutomationProvider {
  return mode === 'pw-screencast' || mode === 'pw-popout' ? 'playwright' : 'agent-browser';
}
export function isPopout(mode: unknown): boolean { return mode === 'ab-popout' || mode === 'pw-popout'; }
export function isScreencast(mode: unknown): boolean { return mode === 'ab-screencast' || mode === 'pw-screencast'; }
export function automationMode(provider: BrowserAutomationProvider, headed: boolean): RenderMode {
  return provider === 'playwright' ? headed ? 'pw-popout' : 'pw-screencast' : headed ? 'ab-popout' : 'ab-screencast';
}
export type BrowserPlatform = Pick<PlatformAdapter,
  | 'agentBrowserCommand' | 'agentBrowserEdit' | 'agentBrowserScreenshot'
  | 'agentBrowserStreamStatus' | 'getAgentBrowserStreamUrl' | 'agentBrowserOpen'
  | 'agentBrowserPopOut' | 'agentBrowserPopIn'
>;

export function browserPlatform(mode: unknown, cwd?: string): BrowserPlatform {
  const platform = getPlatform();
  if (automationProvider(mode) === 'agent-browser') return platform;
  const invoke = platform.playwright;
  if (!invoke) return {};
  const call = (request: PlaywrightRequest) => invoke.call(platform, { cwd, ...request });
  return {
    agentBrowserCommand: async (session: string, args: string[], binaryPath?: string) => {
      const r = await call({ op: 'command', session, args, binaryPath });
      return { exitCode: r.exitCode ?? (r.ok ? 0 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? r.error ?? '' };
    },
    agentBrowserEdit: (session: string, edit: 'selectAll' | 'copy' | 'cut', binaryPath?: string) => call({ op: 'edit', session, edit, binaryPath }),
    agentBrowserScreenshot: async (session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string) => {
      const r = await call({ op: 'screenshot', session, ...opts, binaryPath });
      // JSON transports materialize Uint8Array as an ordinary array.
      if (r.bytes) r.bytes = new Uint8Array(r.bytes);
      return r;
    },
    agentBrowserStreamStatus: (session: string, binaryPath?: string) => call({ op: 'streamStatus', session, binaryPath }),
    getAgentBrowserStreamUrl: async (port: number) => {
      const r = await call({ op: 'streamUrl', port });
      if (!r.ok || !r.url) throw new Error(r.error ?? 'Playwright stream unavailable');
      return r.url;
    },
    agentBrowserOpen: (url: string, opts: { headed?: boolean }, binaryPath?: string) => call({ op: 'open', url, ...opts, binaryPath }),
    agentBrowserPopOut: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popOut', session, ...opts, binaryPath }),
    agentBrowserPopIn: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popIn', session, ...opts, binaryPath }),
  };
}

export function browserSessionKey(session: string, mode: unknown, cwd?: string): string {
  return automationProvider(mode) === 'playwright' ? JSON.stringify(['playwright', cwd ?? '', session]) : session;
}
