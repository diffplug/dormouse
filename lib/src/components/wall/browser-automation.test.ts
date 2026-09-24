import { describe, expect, it } from 'vitest';
import { automationMode, automationProvider, isPopout, isScreencast, LaunchBinaryPath } from './browser-automation';
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
