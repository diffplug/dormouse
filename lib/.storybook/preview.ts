import type { Preview } from '@storybook/react';
import { useEffect, useLayoutEffect, StrictMode } from 'react';
import { createElement } from 'react';
import '../src/theme.css';
import '../src/index.css';
import { initPlatform, type FakePtyAdapter, type FakeScenario } from '../src/lib/platform';
import {
  clearPrimedActivity,
  disposeAllSessions,
  getActivitySnapshot,
  getTerminalPaneStateSnapshot,
  primeActivity,
  removeTerminalPaneState,
  resetTerminalPaneState,
  type ActivityState,
  type TerminalPaneState,
} from '../src/lib/terminal-registry';
import { computeDynamicPalette } from '../src/lib/themes/dynamic-palette';
import { VSCODE_THEMES, VSCODE_THEME_TYPES } from './themes';
import { cfg } from '../src/cfg';

// Initialize fake platform once at module scope
const fakePlatform = initPlatform('fake');

// Pin animations at T=0 for deterministic Chromatic snapshots
if (window?.navigator?.userAgent?.includes('Chromatic')) {
  cfg.marchingAnts.paused = true;
  cfg.alert.ringingPaused = true;
}

// Collect all CSS variable names across all themes for cleanup
const ALL_THEME_VARS = new Set(
  Object.values(VSCODE_THEMES).flatMap((theme) => Object.keys(theme)),
);

const DYNAMIC_PALETTE_VARS = [
  '--color-door-bg',
  '--color-door-fg',
  '--color-focus-ring',
  '--color-alarm-vs-header-active',
  '--color-alarm-vs-header-inactive',
  '--color-alarm-vs-door',
] as const;
const PREFERRED_STORYBOOK_THEME = 'Light (Visual Studio)';
const FIRST_STORYBOOK_THEME = Object.keys(VSCODE_THEMES)[0] ?? '';
const DEFAULT_STORYBOOK_THEME = VSCODE_THEMES[PREFERRED_STORYBOOK_THEME]
  ? PREFERRED_STORYBOOK_THEME
  : FIRST_STORYBOOK_THEME;

function setStylePropertyIfChanged(
  style: CSSStyleDeclaration,
  name: string,
  value: string,
) {
  if (style.getPropertyValue(name) === value) return;
  style.setProperty(name, value);
}

function removeStylePropertyIfPresent(style: CSSStyleDeclaration, name: string) {
  if (!style.getPropertyValue(name)) return;
  style.removeProperty(name);
}

function publishDynamicPalette(body: HTMLElement, ctx: CanvasRenderingContext2D) {
  const dynamicPalette = computeDynamicPalette(getComputedStyle(body), ctx);

  for (const key of DYNAMIC_PALETTE_VARS) {
    const value = dynamicPalette[key];
    if (value) setStylePropertyIfChanged(body.style, key, value);
    else removeStylePropertyIfPresent(body.style, key);
  }
}

function applyStorybookTheme(themeName: string) {
  const theme = VSCODE_THEMES[themeName];
  const themeType = VSCODE_THEME_TYPES[themeName];
  const root = document.documentElement;
  const body = document.body;

  // Clear all theme variables first to prevent stale values from previous theme.
  // Storybook writes both root and body: root simulates VSCode's host globals,
  // body matches applyTheme(), which is what standalone/website use.
  for (const key of ALL_THEME_VARS) {
    removeStylePropertyIfPresent(root.style, key);
    removeStylePropertyIfPresent(body.style, key);
  }
  for (const key of DYNAMIC_PALETTE_VARS) {
    removeStylePropertyIfPresent(body.style, key);
  }

  if (theme) {
    for (const [key, value] of Object.entries(theme)) {
      root.style.setProperty(key, value);
      body.style.setProperty(key, value);
    }
  }

  body.classList.toggle('vscode-light', themeType === 'light');
  body.classList.toggle('vscode-dark', themeType !== 'light');

  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx) publishDynamicPalette(body, ctx);
}

function resolveStorybookTheme(requestedThemeName: string | undefined) {
  if (requestedThemeName && VSCODE_THEMES[requestedThemeName]) {
    return requestedThemeName;
  }
  return DEFAULT_STORYBOOK_THEME;
}

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
  },
  globalTypes: {
    theme: {
      description: 'VSCode theme simulation',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: Object.keys(VSCODE_THEMES),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: DEFAULT_STORYBOOK_THEME,
  },
  decorators: [
    // Exercise React StrictMode (dev double-invoke) so story-rendered components
    // get the same correctness checks as the app entries (lib web + standalone).
    (Story) => createElement(StrictMode, null, createElement(Story)),
    // Theme switcher: inject --vscode-* CSS variables
    (Story, context) => {
      const requestedThemeName = context.globals.theme as string | undefined;
      const themeName = resolveStorybookTheme(requestedThemeName);

      applyStorybookTheme(themeName);
      useLayoutEffect(() => {
        applyStorybookTheme(themeName);

        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return;

        const update = () => publishDynamicPalette(document.body, ctx);
        const observer = new MutationObserver(update);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        update();

        return () => observer.disconnect();
      }, [themeName]);

      // Force remount on theme change so terminals pick up new colors
      return createElement('div', { key: themeName, style: { display: 'flex', flexDirection: 'column' as const, height: '100vh' } }, createElement(Story));
    },
    // FakePty: set scenario from parameters, clean up on unmount
    (Story, context) => {
      const scenario = (context.parameters?.fakePty as { scenario?: FakeScenario })?.scenario;
      const primedSessionState = context.parameters?.primedSessionState as
        | {
            byId?: Record<string, Partial<ActivityState>>;
            byIndex?: Partial<ActivityState>[];
          }
        | undefined;
      const primedTerminalState = context.parameters?.primedTerminalState as
        | {
            byId?: Record<string, Partial<TerminalPaneState>>;
          }
        | undefined;
      const platform = fakePlatform as FakePtyAdapter;

      if (scenario) platform.setDefaultScenario(scenario);
      else platform.clearDefaultScenario();

      useEffect(() => {
        let raf2 = 0;

        const applyPrimedState = () => {
          clearPrimedActivity();
          for (const id of getTerminalPaneStateSnapshot().keys()) {
            removeTerminalPaneState(id);
          }

          for (const [id, state] of Object.entries(primedTerminalState?.byId ?? {})) {
            resetTerminalPaneState(id, state);
          }

          for (const [id, state] of Object.entries(primedSessionState?.byId ?? {})) {
            primeActivity(id, state);
          }

          const sessionIds = [...getActivitySnapshot().keys()];
          primedSessionState?.byIndex?.forEach((state, index) => {
            const id = sessionIds[index];
            if (id) {
              primeActivity(id, state);
            }
          });
        };

        const raf1 = window.requestAnimationFrame(() => {
          raf2 = window.requestAnimationFrame(applyPrimedState);
        });

        return () => {
          window.cancelAnimationFrame(raf1);
          window.cancelAnimationFrame(raf2);
          clearPrimedActivity();
          for (const id of getTerminalPaneStateSnapshot().keys()) {
            removeTerminalPaneState(id);
          }
          platform.clearDefaultScenario();
          disposeAllSessions();
        };
      }, [platform, primedSessionState, primedTerminalState]);

      return createElement(Story);
    },
  ],
};

export default preview;
