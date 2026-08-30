import type { Preview } from '@storybook/react';
import isChromatic from 'chromatic/isChromatic';
import { useEffect, useLayoutEffect, StrictMode } from 'react';
import { createElement } from 'react';
import '../src/theme.css';
import '../src/index.css';
import { initPlatform, type FakeScenario } from '../src/lib/platform';
import {
  applyAlertSettingsFromHost,
  clearPrimedActivity,
  disposeAllSessions,
  getActivitySnapshot,
  getTerminalPaneStateSnapshot,
  getWatchedCommands,
  primeActivity,
  removeTerminalPaneState,
  resetPushDevices,
  resetTerminalPaneState,
  setCommandWatched,
  setPushDevices,
  type ActivityState,
  type AlertSettings,
  type PushDevicesState,
  type TerminalPaneState,
} from '../src/lib/terminal-registry';
import { computeDynamicPalette } from '../src/lib/themes/dynamic-palette';
import {
  clearAllAlertSpeechStates,
  setAlertSpeechState,
  type AlertSpeechState,
} from '../src/lib/alert-speech-state';
import { VSCODE_THEMES, VSCODE_THEME_TYPES } from './themes';
import {
  makeStubRemoteHostLink,
  type PrimedRemoteHost,
} from '../src/host/remote/test-remote-host-link';
import { cfg } from '../src/cfg';
import type { DormouseTheme } from '../src/lib/themes';
import { clearPersistedShellSelection, seedShellStore } from '../src/lib/shell-store';
import type { ShellEntry } from '../src/lib/shell-defaults';

/** Fallback for one frame when the renderer is not painting (see `afterFrame`).
 *  Matches `paintFrame()` in `settle-terminals.ts`: long enough that a slow-but-real
 *  frame still wins the race, so the fallback only ever covers a renderer that is
 *  not painting at all. */
const FRAME_FALLBACK_MS = 100;

// Initialize fake platform once at module scope
const fakePlatform = initPlatform('fake');

// Pin animations at T=0 for deterministic Chromatic snapshots.
//
// Ask `isChromatic()`, never the user agent: Chromatic only rewrites the UA on
// its Chrome runner, and identifies every other browser (Safari, Firefox, Edge)
// with a `chromatic=true` query parameter instead. A UA sniff therefore left
// every guard below OFF in Safari — a bell ringing on an 800ms infinite loop, a
// blinking cursor, terminals on WebGL, and mid-tween pane geometry — which is
// what made the Safari snapshots unstable while Chrome's stayed clean.
if (isChromatic()) {
  cfg.marchingAnts.paused = true;
  cfg.alert.ringingPaused = true;
  // A blinking cursor is captured on-or-off depending on the frame; freeze it to a
  // stable solid block so the terminal contributes no non-determinism.
  cfg.terminal.cursorBlink = false;
  // Keep terminals on the DOM renderer. WebGL paints into a <canvas>, which
  // snapshots as an opaque bitmap and varies with the GPU/driver the runner
  // happens to get; styled spans diff deterministically.
  cfg.terminal.webglRenderer = false;
  // Snap pane splits/restores to their final geometry instead of tweening. A
  // mid-tween split resizes panes through many transient widths, and xterm's DOM
  // renderer can latch a frame where a pane is still narrow — freezing its last
  // line clipped (`user@dormouse:~$` → `user@do`) even after the layout settles.
  // Instant geometry removes that race at the source.
  cfg.layout.animate = false;
  // Let the illegal-rename warning stand. It normally removes itself three
  // seconds after it appears, which a play function cannot outrun: whether it is
  // still on screen at capture time depends on how loaded the runner is.
  cfg.overlays.warningAutoDismissMs = 0;
  // Zero every CSS transition. Unlike the keyframe animations above, each of
  // which has a static substitute, transitions are started by state that lands
  // AFTER first paint — the primed-state decorator applies two rAFs in, which
  // kicks off the bell's `transition-transform` rotation — so a capture can land
  // mid-tween. Only the duration is overridden, so the resting appearance is
  // unchanged; it is simply reached on the first frame. An author `!important`
  // outranks even inline transition declarations (the selection ring's
  // unfocus-saturate fade), so a snapshot showing such a fade already finished
  // is expected, not a regression.
  const instantTransitions = document.createElement('style');
  instantTransitions.textContent =
    '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }';
  document.head.appendChild(instantTransitions);
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
  '--color-alarm-vs-terminal',
] as const;
const PREFERRED_STORYBOOK_THEME = 'Light (Visual Studio)';
const FIRST_STORYBOOK_THEME = Object.keys(VSCODE_THEMES)[0] ?? '';
const DEFAULT_STORYBOOK_THEME = VSCODE_THEMES[PREFERRED_STORYBOOK_THEME]
  ? PREFERRED_STORYBOOK_THEME
  : FIRST_STORYBOOK_THEME;

/**
 * Replace the WATCHING rule set (`docs/specs/alert.md`). The set is app-global
 * and persists to localStorage, so a story that sets a rule would otherwise leak
 * it into every story that runs after it — always clear before applying.
 */
function applyWatchedCommands(names: readonly string[]): void {
  for (const existing of getWatchedCommands()) setCommandWatched(existing, false);
  for (const name of names) setCommandWatched(name, true);
}

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
      const primedWatchedCommands = context.parameters?.primedWatchedCommands as
        | readonly string[]
        | undefined;
      const primedAlertSettings = context.parameters?.primedAlertSettings as
        | Partial<AlertSettings>
        | undefined;
      const primedPushDevices = context.parameters?.primedPushDevices as
        | PushDevicesState
        | undefined;
      const primedAlertSpeech = context.parameters?.primedAlertSpeech as
        | Record<string, AlertSpeechState>
        | undefined;
      const platform = fakePlatform;

      if (scenario) platform.setDefaultScenario(scenario);
      else platform.clearDefaultScenario();

      // Both of these are read during render, so they are applied here rather
      // than in the effect below with the rest of the primed state.

      // The VS Code host owns the theme, which is how the Settings dialog
      // decides to hide its Theme row (docs/specs/theme.md). Absent resets to
      // undefined so it cannot leak into the next story.
      platform.hostOwnsTheme = context.parameters?.hostOwnsTheme === true || undefined;

      // Likewise for shell selection: VS Code's native QuickPick owns it, which
      // is how the Settings dialog decides to hide its Shell row.
      platform.hostOwnsShells = context.parameters?.hostOwnsShells === true || undefined;

      // And the same seam again for the Settings dialog's Remote control
      // section, which renders nothing without a Host service behind the
      // webview (`docs/specs/server.md`). Absent is the honest default for a
      // fake platform, so only the stories about that section prime a stub.
      // Read during render like the two above: the store reads `remoteHost`
      // when the section first subscribes, which is after this decorator's
      // render body and before any effect.
      const primedRemoteHost = context.parameters?.primedRemoteHost as
        | PrimedRemoteHost
        | undefined;
      platform.remoteHost = primedRemoteHost
        ? makeStubRemoteHostLink(primedRemoteHost)
        : undefined;

      // Installed themes normally arrive from OpenVSX and live in localStorage,
      // which every story shares — so a story that wants them names them, and
      // every other story clears them.
      const primedInstalledThemes = context.parameters?.primedInstalledThemes as
        | DormouseTheme[]
        | undefined;
      if (primedInstalledThemes?.length) {
        window.localStorage.setItem(
          'dormouse:installed-themes',
          JSON.stringify(primedInstalledThemes),
        );
      } else {
        window.localStorage.removeItem('dormouse:installed-themes');
      }

      // Shells are detected by the host at boot and seeded into a module store,
      // which no story runs — so a story that wants the Shell row names its
      // shells, and every other story empties the store (seeding nothing is what
      // emptying it is). Clear the persisted choice because localStorage is
      // shared like the themes above. An unchanged shell list intentionally
      // preserves the live choice across re-renders (and same-list stories) so
      // the render-time seed does not notify subscribers; `shell-store.ts`
      // documents that tradeoff.
      const primedShells = context.parameters?.primedShells as ShellEntry[] | undefined;
      clearPersistedShellSelection();
      seedShellStore(primedShells ?? []);

      useEffect(() => {
        let cancelled = false;
        let raf = 0;
        let timer = 0;
        // Play functions gate on this marker (`waitForPrimedState`). Priming lands
        // two rAFs after mount, so a play function that acts on a fixed timer can
        // drive the pre-primed header — clicking a TODO pill that has not rendered
        // yet, or opening a dialog that then re-measures against different content.
        delete document.documentElement.dataset.storyPrimed;

        const applyPrimedState = () => {
          applyWatchedCommands(primedWatchedCommands ?? []);
          // Alarm settings (`docs/specs/alert.md` -> Alarm settings) leak between
          // stories the same way the rule set above does. No merge needed:
          // applyAlertSettingsFromHost normalizes, so a partial — or undefined —
          // resets every field it does not name.
          applyAlertSettingsFromHost(primedAlertSettings);
          // The push-device list is renderer-only derived state normally written
          // by the remote Host, which no story runs — so a story that wants the
          // Alarm dialog's device line names one, and every other story resets
          // to `no-host`.
          setPushDevices(primedPushDevices ?? { status: 'no-host', devices: [] });
          clearAllAlertSpeechStates();
          for (const [id, state] of Object.entries(primedAlertSpeech ?? {})) {
            setAlertSpeechState(id, state);
          }
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

          document.documentElement.dataset.storyPrimed = 'true';
        };

        // Two frames in, so the story's own mount effects (sessions created, panes
        // laid out) have run before `byIndex` reads the session order.
        //
        // Each frame is `rAF` OR a short timer, whichever comes first — never rAF
        // alone. A renderer that is not painting (a hidden or occluded tab, a
        // throttled background window) never fires rAF at all, which would leave
        // every primed story rendering its unprimed default: no TODO pill, no
        // notification, a bell with nothing to show. `settle-terminals.ts` holds
        // the same rule for the same reason.
        const afterFrame = (fn: () => void) => {
          let done = false;
          const run = () => {
            if (done || cancelled) return;
            done = true;
            fn();
          };
          raf = window.requestAnimationFrame(run);
          timer = window.setTimeout(run, FRAME_FALLBACK_MS);
        };
        afterFrame(() => afterFrame(applyPrimedState));

        return () => {
          cancelled = true;
          window.cancelAnimationFrame(raf);
          window.clearTimeout(timer);
          delete document.documentElement.dataset.storyPrimed;
          applyWatchedCommands([]);
          applyAlertSettingsFromHost(undefined);
          resetPushDevices();
          clearAllAlertSpeechStates();
          clearPrimedActivity();
          for (const id of getTerminalPaneStateSnapshot().keys()) {
            removeTerminalPaneState(id);
          }
          platform.clearDefaultScenario();
          disposeAllSessions();
        };
      }, [platform, primedSessionState, primedTerminalState, primedWatchedCommands, primedAlertSettings, primedPushDevices, primedAlertSpeech]);

      return createElement(Story);
    },
  ],
};

export default preview;
