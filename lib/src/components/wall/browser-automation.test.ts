import { afterEach, describe, expect, it } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { BROWSER_PROVIDER_IDS, renderModeFor } from 'dor-lib-common/browser-providers';
import { forgetLaunchBinaryPaths, launchBinaryPath, offeredRenderModes, rememberLaunchBinaryPath } from './browser-automation';
import { browserDisplayMode } from './agent-browser-screen';
import { BROWSER_DISPLAY_LABEL } from './BrowserDisplayIcon';
import { resolveRenderMode } from './browser-surface';
import { installBrowserHost } from './wall-test-utils';

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
    expect(display('agent-browser-screencast', true)).toBe('agent-browser-resize');
    expect(display('agent-browser-screencast', false)).toBe('agent-browser-fixed');
    expect(display('playwright-popout', true)).toBe('playwright-popout');
    expect(display('iframe', true)).toBe('iframe');
    expect(BROWSER_DISPLAY_LABEL['playwright-resize']).toBe('playwright resizes with pane');
    expect(BROWSER_DISPLAY_LABEL['agent-browser-popout']).toBe('agent-browser popout');
    expect(BROWSER_DISPLAY_LABEL.iframe).toBe('iframe embed');
  });
});

describe('launchBinaryPath', () => {
  afterEach(forgetLaunchBinaryPaths);

  it('hands each provider\'s GUI launches the binary path its own command resolved', () => {
    rememberLaunchBinaryPath('playwright', '/opt/bin/playwright-cli');
    expect(launchBinaryPath('agent-browser')).toBeUndefined();
    expect(launchBinaryPath('playwright')).toBe('/opt/bin/playwright-cli');
    rememberLaunchBinaryPath('agent-browser', '/opt/bin/agent-browser');
    expect(launchBinaryPath('agent-browser')).toBe('/opt/bin/agent-browser');
    expect(launchBinaryPath('playwright')).toBe('/opt/bin/playwright-cli');
  });
});

describe('offeredRenderModes', () => {
  afterEach(() => setPlatform(new FakePtyAdapter()));

  it('offers a provider\'s screencast and popout only where the host drives it', () => {
    installBrowserHost({}, ['agent-browser']);
    expect(offeredRenderModes(false, null)).toEqual(['agent-browser-screencast', 'agent-browser-popout', 'iframe']);
    installBrowserHost({}, ['agent-browser', 'playwright']);
    expect(offeredRenderModes(false, null)).toEqual(['agent-browser-screencast', 'agent-browser-popout', 'playwright-screencast', 'playwright-popout', 'iframe']);
  });

  it('keeps the running provider\'s screencast on a host that cannot drive it', () => {
    installBrowserHost({}, ['playwright']);
    expect(offeredRenderModes(false, 'agent-browser')).toEqual(['agent-browser-screencast', 'playwright-screencast', 'playwright-popout', 'iframe']);
    // A host with no browser request at all offers no automated renderer but that one.
    setPlatform(Object.assign(new FakePtyAdapter(), { browserProviders: ['agent-browser'] } satisfies Partial<PlatformAdapter>));
    expect(offeredRenderModes(false, 'agent-browser')).toEqual(['agent-browser-screencast', 'iframe']);
    expect(offeredRenderModes(false, null)).toEqual(['iframe']);
  });

  it('offers a Tool only its declarable renders', () => {
    installBrowserHost();
    expect(offeredRenderModes(true, null)).toEqual(['agent-browser-screencast', 'playwright-screencast', 'iframe']);
    expect(offeredRenderModes(true, 'agent-browser')).toEqual(['agent-browser-screencast', 'playwright-screencast', 'iframe']);
  });
});
