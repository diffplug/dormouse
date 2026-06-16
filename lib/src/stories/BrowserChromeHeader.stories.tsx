import { useEffect, useId, useMemo, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedContext,
  type WallActions,
} from '../components/Wall';
import { SurfacePaneHeader } from '../components/wall/SurfacePaneHeader';
import {
  registerAgentBrowserScreen,
  type ChromeConnection,
  type ChromeSnapshot,
  type ScreenRegistration,
  type ScreenSnapshot,
  type ScreenState,
} from '../components/wall/agent-browser-screen';
import { hostPathDisplay, loopbackPort } from '../components/wall/browser-url';
import { setDevServerResolution } from '../components/wall/agent-browser-ports';

/**
 * Playground for the agent-browser surface's browser-chrome header
 * (docs/specs/dor-agent-browser.md → "Browser-Chrome Header").
 *
 * `SurfacePaneHeader` decides "this is a browser surface" purely from the
 * presence of a screen controller for its `api.id`, and reads URL / key /
 * connection from that controller's chrome snapshot. So the story registers a
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
};

interface StoryArgs {
  /** Drives the SYNCED/SCALED chip + the modal it opens. */
  state: ScreenState;
  /** Active tab URL — also the source of the host+path text and loopback port. */
  url: string;
  /** Active tab HTML <title> (shown as the URL's tooltip). */
  htmlTitle: string;
  /** Managed --key; '' = raw --session (no badge), 'default' is skipped. */
  paneKey: string;
  connection: ChromeConnection;
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
    viewport: { w: 1280, h: 720, dpr: 1 },
    paneCss: args.state === 'SYNCED' ? { w: 1280, h: 720 } : { w: 980, h: 560 },
    displayDpr: 2,
    syncEngaged: args.state === 'SYNCED',
  }), [args.state]);

  const chromeSnapshot: ChromeSnapshot = useMemo(() => ({
    url: args.url,
    displayUrl: hostPathDisplay(args.url),
    title: args.htmlTitle || null,
    key: args.paneKey || null,
    connection: args.connection,
  }), [args.url, args.htmlTitle, args.paneKey, args.connection]);

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
      },
      chromeActions: {
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

  const mockApi = { id: surfaceId, title: args.htmlTitle || hostPathDisplay(args.url) } as never;

  return (
    <ModeContext.Provider value="passthrough">
      <SelectedIdContext.Provider value={args.selected ? surfaceId : null}>
        <WindowFocusedContext.Provider value={true}>
          <ZoomedContext.Provider value={false}>
            <WallActionsContext.Provider value={loggingActions}>
              <div style={{ width: args.width }}>
                <div className="bg-app-bg" style={{ height: 26 }}>
                  <SurfacePaneHeader api={mockApi} containerApi={{} as never} params={{}} tabLocation={'header' as never} />
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
    state: { control: 'radio', options: ['SYNCED', 'SCALED'] },
    url: { control: 'text' },
    htmlTitle: { control: 'text' },
    paneKey: { control: 'select', options: ['', 'default', 'storybook'] },
    connection: { control: 'radio', options: ['connected', 'connecting', 'lost'] },
    devServerLabel: { control: 'text' },
    hostCapable: { control: 'boolean' },
    width: { control: { type: 'range', min: 200, max: 900, step: 10 } },
    selected: { control: 'boolean' },
  },
  args: {
    state: 'SYNCED',
    url: 'http://localhost:5173/app',
    htmlTitle: 'Vite + React',
    paneKey: 'storybook',
    connection: 'connected',
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

/** Session stream dropped — connection is lost. */
export const ConnectionLost: Story = {
  args: { connection: 'lost' },
};

/** Narrow header: split/zoom collapse first (≤420px), then nav (≤360px). */
export const Narrow: Story = {
  args: { width: 340 },
};
