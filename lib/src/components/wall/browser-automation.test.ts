import { afterEach, describe, expect, it } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { BROWSER_PROVIDER_IDS, renderModeFor } from 'dor-lib-common/browser-providers';
import { forgetLaunchBinaryPaths, launchBinaryPath, offeredRenderModes, rememberLaunchBinaryPath } from './browser-automation';
import { browserDisplayMode } from './agent-browser-screen';
import { BROWSER_DISPLAY_LABEL } from './BrowserDisplayIcon';
import { resolveRenderMode } from './browser-surface';

describe('automation render modes', () => {
  it('resolves every provider presentation, and anything else as the embed', () => {
    for (const provider of BROWSER_PROVIDER_IDS) {
      for (const presentation of ['screencast', 'popout'] as const) {
        const mode = renderModeFor(provider, presentation);
        expect(resolveRenderMode({ renderMode: mode })).toBe(mode);
      }
    }
    for (const mode of ['iframe', undefined, 'constructor', 'toString']) {
      expect(resolveRenderMode({ renderMode: mode })).toBe('iframe');
    }
  });

  it('derives each display mode and its label from the provider registry', () => {
    const display = (renderMode: Parameters<typeof browserDisplayMode>[0]['renderMode'], syncEngaged: boolean) => browserDisplayMode({ renderMode, syncEngaged });
    expect(display('ab-screencast', true)).toBe('ab-resize');
    expect(display('ab-screencast', false)).toBe('ab-fixed');
    expect(display('pw-popout', true)).toBe('pw-popout');
    expect(display('iframe', true)).toBe('iframe');
    expect(BROWSER_DISPLAY_LABEL['pw-resize']).toBe('Playwright resizes with pane');
    expect(BROWSER_DISPLAY_LABEL['ab-popout']).toBe('agent-browser popout');
    expect(BROWSER_DISPLAY_LABEL.iframe).toBe('iframe embed');
  });
});

describe('launchBinaryPath', () => {
  afterEach(forgetLaunchBinaryPaths);

  it('hands GUI launches only the agent-browser binary path', () => {
    rememberLaunchBinaryPath('playwright', '/opt/bin/playwright-cli');
    expect(launchBinaryPath('agent-browser')).toBeUndefined();
    rememberLaunchBinaryPath('agent-browser', '/opt/bin/agent-browser');
    expect(launchBinaryPath('agent-browser')).toBe('/opt/bin/agent-browser');
    expect(launchBinaryPath('playwright')).toBeUndefined();
  });
});

describe('offeredRenderModes', () => {
  afterEach(() => setPlatform(new FakePtyAdapter()));

  function host(capabilities: Partial<PlatformAdapter>): void {
    setPlatform(Object.assign(new FakePtyAdapter(), capabilities));
  }
  const ok = async () => ({ ok: true });

  it('offers a provider only where the host can launch it, and its popout only where it can pop out', () => {
    host({ agentBrowserOpen: ok, agentBrowserPopOut: ok });
    expect(offeredRenderModes(false, null)).toEqual(['ab-screencast', 'ab-popout', 'iframe']);
    host({ agentBrowserOpen: ok, playwright: ok });
    // Playwright's host wires every operation behind its one entry point.
    expect(offeredRenderModes(false, null)).toEqual(['ab-screencast', 'pw-screencast', 'pw-popout', 'iframe']);
  });

  it('keeps the running provider, which relaunches in place rather than launching', () => {
    host({ agentBrowserPopOut: ok });
    expect(offeredRenderModes(false, 'agent-browser')).toEqual(['ab-screencast', 'ab-popout', 'iframe']);
    expect(offeredRenderModes(false, null)).toEqual(['iframe']);
  });

  it('offers a Tool only its declarable renders', () => {
    host({ agentBrowserOpen: ok, agentBrowserPopOut: ok, playwright: ok });
    expect(offeredRenderModes(true, null)).toEqual(['ab-screencast', 'iframe']);
    expect(offeredRenderModes(true, 'agent-browser')).toEqual(['ab-screencast', 'iframe']);
  });
});
