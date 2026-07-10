import { useEffect, useId, useMemo, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedContext,
  type WallActions,
} from '../components/wall/wall-context';
import { SurfacePaneHeader } from '../components/wall/SurfacePaneHeader';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type RenderMode,
  type ScreenRegistration,
  type ScreenSnapshot,
  type ScreenState,
} from '../components/wall/agent-browser-screen';
import { hostPathDisplay, loopbackPort } from '../components/wall/browser-url';
import { setDevServerResolution } from '../components/wall/agent-browser-ports';

/**
 * Playground for the agent-browser surface's browser-chrome header
 * (docs/specs/dor-browser.md → "Browser Chrome").
 *
 * `SurfacePaneHeader` decides "this is a browser surface" purely from the
 * presence of a screen controller for its `api.id`, and reads URL / key from
 * that controller's chrome snapshot. So the story registers a
 * controller backed by the args and pushes updates as the controls change —
 * exactly the real body→header path, just driven by knobs instead of a live
 * stream. The dev-server chip is wired through the genuine port store.
 */

// Actions log to the console so nav / focus clicks are observable in the story.
const loggingActions: WallActions = {
  onKill: () => console.log('[story] kill'),
  onMinimize: () => console.log('[story] minimize'),
  onAlertButton: () => 'noop',
  onToggleTodo: () => {},
  onSplitH: () => console.log('[story] split left/right'),
  onSplitV: () => console.log('[story] split top/bottom'),
  onZoom: () => console.log('[story] zoom'),
  onClickPanel: () => console.log('[story] click panel'),
  onFocusPane: (id) => console.log('[story] focus pane', id),
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: (id, mode) => console.log('[story] swap render', id, mode),
  resolveSurfaceRef: (id) => id,
  onConnectPort: async (id, url) => {
    console.log('[story] connect port', id, url);
    return { ok: true };
  },
};

interface StoryArgs {
  /** Render backend — drives the far-left chip glyph: frame = embed, lock =
   *  screencast (closed when synced, open when scaled). */
  renderMode: RenderMode;
  /** Drives the SYNCED/SCALED chip + the modal it opens. */
  state: ScreenState;
  /** Active tab URL — also the source of the host+path text and loopback port. */
  url: string;
  /** Active tab HTML <title> (shown as the URL's tooltip). */
  htmlTitle: string;
  /** Managed --key; '' = raw --session (no badge), 'default' is skipped. */
  paneKey: string;
  /** Pane label for the dev-server chip; '' = no pane correlates (chip hidden). */
  devServerLabel: string;
  /** Whether the host can run agent-browser commands (false ⇒ nav/resize inert). */
  hostCapable: boolean;
  /** Header width — shrink past 420/360 to watch split-zoom then nav collapse. */
  width: number;
  /** Whether the surface is the selected/active pane (header highlight). */
  selected: boolean;
}

function BrowserChromeStory(args: StoryArgs) {
  // Unique per story instance so autodocs (which mounts several at once) don't
  // collide on one registry id.
  const surfaceId = useId();
  const registrationRef = useRef<ScreenRegistration | null>(null);

  const screenSnapshot: ScreenSnapshot = useMemo(() => ({
    state: args.state,
    renderMode: args.renderMode,
    viewport: { w: 1280, h: 720, dpr: 1 },
    paneCss: args.state === 'SYNCED' ? { w: 1280, h: 720 } : { w: 980, h: 560 },
    displayDpr: 2,
    syncEngaged: args.state === 'SYNCED',
  }), [args.state, args.renderMode]);

  const chromeSnapshot: ChromeSnapshot = useMemo(() => ({
    url: args.url,
    displayUrl: hostPathDisplay(args.url),
    title: args.htmlTitle || null,
    key: args.paneKey || null,
  }), [args.url, args.htmlTitle, args.paneKey]);

  // Register on mount; re-register when hostCapable flips (it's fixed at
  // registration time). The update effects below keep the snapshots live.
  useEffect(() => {
    const registration = registerAgentBrowserScreen(surfaceId, {
      snapshot: screenSnapshot,
      chrome: chromeSnapshot,
      actions: {
        engageSync: () => console.log('[story] engageSync'),
        applyDevice: (name) => console.log('[story] applyDevice', name),
        applyViewport: (w, h, dpr) => console.log('[story] applyViewport', w, h, dpr),
        openModal: () => console.log('[story] openModal'),
        setRenderMode: (mode) => console.log('[story] setRenderMode', mode),
      },
      chromeActions: {
        navigate: (url) => console.log('[story] navigate', url),
        back: () => console.log('[story] back'),
        forward: () => console.log('[story] forward'),
        reload: () => console.log('[story] reload'),
      },
      hostCapable: args.hostCapable,
    });
    registrationRef.current = registration;
    return () => {
      registration.dispose();
      registrationRef.current = null;
    };
    // Re-register only when the surface id or host capability changes; the live
    // snapshots are kept current by the two update effects below.
  }, [surfaceId, args.hostCapable]);

  useEffect(() => {
    registrationRef.current?.update(screenSnapshot);
  }, [screenSnapshot]);

  useEffect(() => {
    registrationRef.current?.updateChrome(chromeSnapshot);
  }, [chromeSnapshot]);

  // Stand in for the Wall's port→pane correlation: when the URL is loopback,
  // publish (or clear) a match for its port so the chip renders.
  const port = loopbackPort(args.url);
  useEffect(() => {
    if (port == null) return;
    const label = args.devServerLabel.trim();
    setDevServerResolution(port, label ? { paneId: 'term-dev', label } : null);
  }, [port, args.devServerLabel]);

  return (
    <ModeContext.Provider value="passthrough">
      <SelectedIdContext.Provider value={args.selected ? surfaceId : null}>
        <WindowFocusedContext.Provider value={true}>
          <ZoomedContext.Provider value={false}>
            <WallActionsContext.Provider value={loggingActions}>
              <div style={{ width: args.width }}>
                <div className="bg-app-bg" style={{ height: 26 }}>
                  <SurfacePaneHeader
                    id={surfaceId}
                    title={args.htmlTitle || hostPathDisplay(args.url)}
                    params={undefined}
                  />
                </div>
              </div>
            </WallActionsContext.Provider>
          </ZoomedContext.Provider>
        </WindowFocusedContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

const meta: Meta<typeof BrowserChromeStory> = {
  title: 'Components/BrowserChromeHeader',
  component: BrowserChromeStory,
  argTypes: {
    renderMode: { control: 'inline-radio', options: ['ab-screencast', 'ab-popout', 'iframe'] },
    state: { control: 'radio', options: ['SYNCED', 'SCALED'] },
    url: { control: 'text' },
    htmlTitle: { control: 'text' },
    paneKey: { control: 'select', options: ['', 'default', 'storybook'] },
    devServerLabel: { control: 'text' },
    hostCapable: { control: 'boolean' },
    width: { control: { type: 'range', min: 200, max: 900, step: 10 } },
    selected: { control: 'boolean' },
  },
  args: {
    renderMode: 'ab-screencast',
    state: 'SYNCED',
    url: 'http://localhost:5173/app',
    htmlTitle: 'Vite + React',
    paneKey: 'storybook',
    devServerLabel: 'pnpm dev',
    hostCapable: true,
    width: 620,
    selected: true,
  },
};

export default meta;
type Story = StoryObj<typeof BrowserChromeStory>;

/** Everything on at once: key badge + URL + dev-server chip + nav. */
export const Playground: Story = {};

/** Pop-out render mode — same agent-browser, relaunched as a native OS window;
 *  the far-left chip becomes the open-window glyph. (The pane body is a stub
 *  while the window is up, but the header chrome stays live.) */
export const Popout: Story = {
  args: { renderMode: 'ab-popout' },
};

/** Embed (iframe) render mode — the unified chrome is identical to screencast,
 *  but the far-left chip becomes the frame-corners glyph. Same URL/nav/dev-server
 *  header; only the chip + body renderer differ. */
export const Embed: Story = {
  args: { renderMode: 'iframe' },
};

/** Letterboxed viewport — the chip reads SCALED (click it for the modal). */
export const Scaled: Story = {
  args: { state: 'SCALED' },
};

/** No --key badge, no dev-server match — the bare host+path case. */
export const RawSession: Story = {
  args: { paneKey: '', devServerLabel: '', url: 'https://example.com/docs' },
};

/** The differentiated piece: a localhost URL correlated to a terminal pane. */
export const DevServerConnected: Story = {
  args: { url: 'http://localhost:6006/', devServerLabel: 'storybook', paneKey: 'storybook' },
};

/** Narrow header: split/zoom collapse first (≤420px), then nav (≤360px). */
export const Narrow: Story = {
  args: { width: 340 },
};
