// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasBrowser, hasTerminal } from 'dor/commands/types';
import {
  isBrowserParams,
  isToolParams,
  namespacedToolKey,
  resolveRenderMode,
  surfaceKindFromParams,
  toolKeysEqual,
  toolShowsBrowser,
} from './browser-surface';
import { persistableLeafMeta, shouldParkOnMinimize, toolLeafMeta } from './lath-wall-engine';
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

describe('tool key matching', () => {
  it('matches element-wise', () => {
    expect(toolKeysEqual(['a', '/r'], ['a', '/r'])).toBe(true);
    expect(toolKeysEqual(['a', '/r'], ['a', '/s'])).toBe(false);
    expect(toolKeysEqual(['a'], ['a', '/r'])).toBe(false);
  });

  it('never matches a keyless tool against anything, including another keyless one', () => {
    expect(toolKeysEqual(undefined, ['a'])).toBe(false);
    expect(toolKeysEqual(['a'], null)).toBe(false);
    expect(toolKeysEqual(undefined, null)).toBe(false);
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

describe('key namespacing (regression: review finding 2)', () => {
  it('keeps two tools in one repo distinct when both declare only a scope', () => {
    // The spec calls the declared list "scope inside that namespace", so
    // scope-only keys are legal — and without a namespace they collide, and
    // `dor tool docs` reports the `api` pane.
    const docs = namespacedToolKey('docs', ['/repo']);
    const api = namespacedToolKey('api', ['/repo']);
    expect(toolKeysEqual(docs, api)).toBe(false);
    expect(toolKeysEqual(docs, docs)).toBe(true);
  });

  it('stops an announcement from claiming another tool’s key', () => {
    // A trusted tool rendering hostile bytes emits OSC 367 with storybook's
    // key. Namespaced under the name the host resolved at spawn, it cannot
    // match storybook's, so a later `dor tool storybook` will not adopt — and
    // Ctrl+C — the announcing pane.
    const storybook = namespacedToolKey('storybook', ['storybook', '/repo']);
    const spoofed = namespacedToolKey('notes', ['storybook', '/repo']);
    expect(toolKeysEqual(storybook, spoofed)).toBe(false);
  });

  it('gives an identityless tool no key, so a re-key cannot mint one', () => {
    expect(namespacedToolKey(null, ['storybook', '/repo'])).toBeNull();
    expect(namespacedToolKey('storybook', null)).toBeNull();
  });
});

describe('tool persistence (regression: review findings 4 and 11)', () => {
  it('strips the derived browser state, so a restart never frames a dead URL', () => {
    const meta = toolLeafMeta('storybook', {
      surfaceType: 'tool',
      command: 'pnpm storybook',
      cwd: '/repo',
      toolKey: ['storybook', 'storybook', '/repo'],
      toolRender: 'ab-screencast',
      url: 'http://localhost:6006/',
      renderMode: 'ab-screencast',
      session: 'dormouse.w.tool.p1',
      wsPort: 51234,
      showTerminal: true,
    });
    expect(persistableLeafMeta(meta).params).toEqual({
      surfaceType: 'tool',
      command: 'pnpm storybook',
      cwd: '/repo',
      toolKey: ['storybook', 'storybook', '/repo'],
      toolRender: 'ab-screencast',
    });
  });

  it('leaves a browser Surface’s params alone', () => {
    const meta = { component: 'browser', tabComponent: 'surface', title: 'B', params: { url: 'https://x', renderMode: 'iframe' } };
    expect(persistableLeafMeta(meta).params).toEqual({ url: 'https://x', renderMode: 'iframe' });
  });
});
