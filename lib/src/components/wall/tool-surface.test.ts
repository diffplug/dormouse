// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasBrowser, hasTerminal } from 'dor/commands/types';
import {
  isBrowserParams,
  isToolParams,
  resolveRenderMode,
  surfaceKindFromParams,
  toolShowsBrowser,
} from './browser-surface';
import { shouldParkOnMinimize, toolLeafMeta } from './lath-wall-engine';
import { TOOLS_FLAG_KEY, isToolsEnabled, setToolsEnabled } from '../../lib/feature-flags';

const booting = { surfaceType: 'tool', command: 'pnpm storybook', cwd: '/repo' };
const serving = { ...booting, url: 'http://localhost:6006/', renderMode: 'iframe' };

describe('tool params classification', () => {
  it('classifies a tool as its own kind, before and after it serves', () => {
    expect(surfaceKindFromParams(booting)).toBe('tool');
    expect(surfaceKindFromParams(serving)).toBe('tool');
  });

  it('never classifies a serving tool as a browser, despite its renderMode', () => {
    // The ordering that matters: `isBrowserParams` matches anything carrying a
    // renderMode, so the tool test has to come first.
    expect(isToolParams(serving)).toBe(true);
    expect(isBrowserParams(serving)).toBe(false);
  });

  it('leaves plain terminals and browsers where they were', () => {
    expect(surfaceKindFromParams(undefined)).toBe('terminal');
    expect(surfaceKindFromParams({ cwd: '/repo' })).toBe('terminal');
    expect(surfaceKindFromParams({ surfaceType: 'browser', url: 'https://x' })).toBe('browser');
    expect(surfaceKindFromParams({ renderMode: 'ab-screencast' })).toBe('browser');
  });

  it('reports both capabilities, so row fields populate on both sides', () => {
    const kind = surfaceKindFromParams(serving);
    expect(hasTerminal(kind)).toBe(true);
    expect(hasBrowser(kind)).toBe(true);
  });
});

describe('which half of a tool is forward', () => {
  it('shows the terminal until the tool serves', () => {
    expect(toolShowsBrowser(booting)).toBe(false);
  });

  it('shows the browser once it serves', () => {
    expect(toolShowsBrowser(serving)).toBe(true);
  });

  it('shows the terminal again when the header chip pins it', () => {
    expect(toolShowsBrowser({ ...serving, showTerminal: true })).toBe(false);
  });

  it('shows the terminal after the command exits and the url is retired', () => {
    expect(toolShowsBrowser({ ...serving, url: undefined })).toBe(false);
  });

  it('never claims a non-tool shows a tool browser', () => {
    expect(toolShowsBrowser({ surfaceType: 'browser', url: 'https://x' })).toBe(false);
  });

  it('defaults a tool with no explicit renderMode to the iframe', () => {
    expect(resolveRenderMode(booting)).toBe('iframe');
  });
});

describe('tool leaf meta', () => {
  it('routes to the tool body and header', () => {
    const meta = toolLeafMeta('storybook', booting);
    expect(meta.component).toBe('tool');
    expect(meta.tabComponent).toBe('tool');
  });

  it('parks on minimize, because a served document lives in the pane DOM', () => {
    expect(shouldParkOnMinimize(toolLeafMeta('storybook', serving))).toBe(true);
    // ...and a terminal still does not: the PTY holds its state and the
    // registry replays it.
    expect(shouldParkOnMinimize({ component: 'terminal', tabComponent: 'terminal', title: 't' })).toBe(false);
  });
});

describe('the tools flag', () => {
  it('is off by default, so nothing is ever designated a tool', () => {
    setToolsEnabled(false);
    expect(isToolsEnabled()).toBe(false);
  });

  it('turns on and off through the documented localStorage key', () => {
    setToolsEnabled(true);
    expect(globalThis.localStorage.getItem(TOOLS_FLAG_KEY)).toBe('true');
    expect(isToolsEnabled()).toBe(true);
    setToolsEnabled(false);
    expect(globalThis.localStorage.getItem(TOOLS_FLAG_KEY)).toBeNull();
  });
});
