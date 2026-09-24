import { afterEach, describe, expect, it } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { automationMode, automationProvider, isPopout, isScreencast, LaunchBinaryPath, offeredRenderModes } from './browser-automation';
import { resolveRenderMode } from './browser-surface';

describe('automation render modes', () => {
  it('maps each provider and headedness to a mode and back', () => {
    for (const provider of ['agent-browser', 'playwright'] as const) {
      for (const headed of [false, true]) {
        const mode = automationMode(provider, headed);
        expect(automationProvider(mode)).toBe(provider);
        expect(isPopout(mode)).toBe(headed);
        expect(isScreencast(mode)).toBe(!headed);
        expect(resolveRenderMode({ renderMode: mode })).toBe(mode);
      }
    }
  });

  it('has no provider for iframe, an unset mode, or a prototype key', () => {
    for (const mode of ['iframe', undefined, 'constructor', 'toString']) {
      expect(automationProvider(mode)).toBeNull();
      expect(isPopout(mode)).toBe(false);
      expect(isScreencast(mode)).toBe(false);
      expect(resolveRenderMode({ renderMode: mode })).toBe('iframe');
    }
  });
});

describe('LaunchBinaryPath', () => {
  it('hands GUI launches only the agent-browser binary path', () => {
    const paths = new LaunchBinaryPath();
    paths.remember('playwright', '/opt/bin/playwright-cli');
    expect(paths.get('agent-browser')).toBeUndefined();
    paths.remember('agent-browser', '/opt/bin/agent-browser');
    expect(paths.get('agent-browser')).toBe('/opt/bin/agent-browser');
    expect(paths.get('playwright')).toBeUndefined();
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
