import { describe, expect, it } from 'vitest';
import { mergeBrowserConfig, parseBrowserConfig, toolViewport } from './browser-config';
import { parseToolFile } from './tool-registry';

describe('browser viewport configuration', () => {
  it('merges complete preset definitions project > user > built-in', () => {
    const user = parseBrowserConfig({ default_viewport: 'phone', viewports: { desktop: { width: 1500, height: 1000, dpr: 2 } } }, 'user');
    const project = parseBrowserConfig({ default_viewport: 'desktop', viewports: { desktop: { width: 1600, height: 900 } } }, 'project');
    const config = mergeBrowserConfig(user, project);
    expect(config.defaultViewport).toBe('desktop');
    expect(config.viewports.desktop).toEqual({ width: 1600, height: 900 });
    expect(config.viewports.phone).toEqual({ width: 390, height: 844 });
    expect(toolViewport('playwright-screencast', undefined, config)).toEqual({ mode: 'fixed', width: 1600, height: 900 });
  });

  it('accepts a browser-only file and pane-sync default', () => {
    const file = parseToolFile('browser:\n  default_viewport: pane-sync\n', { path: '/repo/dormouse.yml', dir: '/repo', scope: 'repo' });
    expect(file.tools.size).toBe(0);
    expect(toolViewport('agent-browser-screencast', undefined, mergeBrowserConfig(file.browser))).toEqual({ mode: 'pane-sync' });
  });

  it('validates names only after layers combine, allowing project use of user presets', () => {
    const project = parseBrowserConfig({ default_viewport: 'wide' }, 'project');
    expect(() => mergeBrowserConfig(project)).toThrow("Unknown browser viewport preset 'wide'");
    const user = parseBrowserConfig({ viewports: { wide: { width: 1800, height: 900 } } }, 'user');
    expect(mergeBrowserConfig(user, project).defaultViewport).toBe('wide');
  });

  it.each([
    { viewports: { 'pane-sync': { width: 1, height: 1 } } },
    { viewports: { x: { width: 0, height: 900 } } },
    { viewports: { x: { width: 16385, height: 900 } } },
    { viewports: { x: { width: 1000.5, height: 900 } } },
    { viewports: { x: { width: 1000, height: 900, dpr: 0 } } },
    { viewports: { x: { width: 1000, height: 900, dpi: 2 } } },
    { default_viewport: 10 },
    { default_viewport: ' desktop ' },
    { viewports: { ' phone ': { width: 390, height: 844 } } },
    { viewports: { ' ': { width: 390, height: 844 } } },
    { defaultViewport: 'desktop' },
  ])('rejects malformed configuration %j', raw => {
    expect(() => parseBrowserConfig(raw, 'fixture.browser')).toThrow(/fixture.browser/);
  });

  it('resolves explicit Tool presets and inline sizes, leaving omitted DPR unspecified', () => {
    const config = mergeBrowserConfig();
    expect(toolViewport('playwright-screencast', 'phone', config)).toEqual({ mode: 'fixed', width: 390, height: 844 });
    expect(toolViewport('agent-browser-screencast', { width: 700, height: 500, dpr: 2 }, config)).toEqual({ mode: 'fixed', width: 700, height: 500, dpr: 2 });
    expect(toolViewport('iframe', undefined, config)).toEqual({ mode: 'pane-sync' });
    expect(() => toolViewport('iframe', 'desktop', config)).toThrow(/iframe Tools/);
  });
});
