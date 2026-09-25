import { useEffect, useId, useMemo, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  type WallActions,
} from '../components/wall/wall-context';
import { SurfacePaneHeader } from '../components/wall/SurfacePaneHeader';
import { recordToolDirty } from '../lib/tool-dirty-store';
import { ToolPaneHeader } from '../components/wall/ToolPaneHeader';
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
  onToggleTodo: () => {},
  onSplitH: () => console.log('[story] split left/right'),
  onSplitV: () => console.log('[story] split top/bottom'),
  onZoom: () => console.log('[story] zoom'),
  onClickPanel: () => console.log('[story] click panel'),
  onEnterPanel: () => console.log('[story] enter panel'),
  onFocusPane: (id) => console.log('[story] focus pane', id),
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: (id, mode) => console.log('[story] swap render', id, mode),
  resolveSurfaceRef: (id) => id,
  onResolveToolApproval: () => {},
};

interface StoryArgs {
  /** Render backend — drives the presentation half of the far-left icon pair. */
  renderMode: RenderMode;
  /** Whether an in-pane agent browser follows pane size or keeps a fixed size. */
  syncEngaged: boolean;
  /** Live viewport match state, independent of the persisted resize intent. */
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
  /** Header width — shrink past 420/360 to watch the splits then nav collapse. */
  width: number;
  /** Include the Tool Terminal Context button beside the browser header. */
  tool: boolean;
  dirty: 'unknown' | 'clean' | 'dirty';
  /** Whether the surface is the selected/active pane (header highlight). */
  selected: boolean;
}

function BrowserChromeStory(args: StoryArgs) {
  // Unique per story instance so autodocs (which mounts several at once) don't
  // collide on one registry id.
  const surfaceId = useId();
  const registrationRef = useRef<ScreenRegistration | null>(null);
  useEffect(() => {
    recordToolDirty(surfaceId, args.dirty === 'unknown' ? null : args.dirty === 'dirty');
    return () => recordToolDirty(surfaceId, null);
  }, [surfaceId, args.dirty]);

  const screenSnapshot: ScreenSnapshot = useMemo(() => ({
    state: args.state,
    renderMode: args.renderMode,
    viewport: { w: 1280, h: 720, dpr: 1 },
    paneCss: args.state === 'SYNCED' ? { w: 1280, h: 720 } : { w: 980, h: 560 },
    displayDpr: 2,
    syncEngaged: args.syncEngaged,
  }), [args.state, args.renderMode, args.syncEngaged]);

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

  const Header = args.tool ? ToolPaneHeader : SurfacePaneHeader;
  return (
    <ModeContext.Provider value="passthrough">
      <SelectedIdContext.Provider value={args.selected ? surfaceId : null}>
        <WindowFocusedContext.Provider value={true}>
          {/* No ZoomedIdContext provider: its `null` default is exactly this
              story's un-zoomed header. */}
          <WallActionsContext.Provider value={loggingActions}>
            <div style={{ width: args.width }}>
              {/* Preserve the compact 26px visual baseline for these isolated headers. */}
              <div className="bg-app-bg" style={{ height: 26 }}>
                <Header
                  id={surfaceId}
                  title={args.htmlTitle || hostPathDisplay(args.url)}
                  params={args.tool ? { surfaceType: 'tool', url: args.url } : undefined}
                />
              </div>
            </div>
          </WallActionsContext.Provider>
        </WindowFocusedContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

const meta: Meta<typeof BrowserChromeStory> = {
  title: 'Components/BrowserChromeHeader',
  component: BrowserChromeStory,
  argTypes: {
    renderMode: { control: 'inline-radio', options: ['agent-browser-screencast', 'agent-browser-popout', 'iframe'] },
    syncEngaged: { control: 'boolean' },
    state: { control: 'radio', options: ['SYNCED', 'SCALED'] },
    url: { control: 'text' },
    htmlTitle: { control: 'text' },
    paneKey: { control: 'select', options: ['', 'default', 'storybook'] },
    devServerLabel: { control: 'text' },
    hostCapable: { control: 'boolean' },
    width: { control: { type: 'range', min: 80, max: 900, step: 10 } },
    selected: { control: 'boolean' },
    tool: { control: 'boolean' },
    dirty: { control: 'inline-radio', options: ['unknown', 'clean', 'dirty'], if: { arg: 'tool' } },
  },
  args: {
    renderMode: 'agent-browser-screencast',
    syncEngaged: true,
    state: 'SYNCED',
    url: 'http://localhost:5173/app',
    htmlTitle: 'Vite + React',
    paneKey: 'storybook',
    devServerLabel: 'pnpm dev',
    hostCapable: true,
    width: 620,
    tool: false,
    dirty: 'unknown',
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
  args: { renderMode: 'agent-browser-popout' },
};

/** Embed (iframe) render mode — the unified chrome is identical to screencast,
 *  but the far-left chip becomes the frame-corners glyph. Same URL/nav/dev-server
 *  header; only the chip + body renderer differ. */
export const Embed: Story = {
  args: { renderMode: 'iframe' },
};

/** Fixed viewport — robot + picture-in-picture, even if its dimensions happen
 *  to match the pane at this instant. */
export const FixedSize: Story = {
  args: { state: 'SYNCED', syncEngaged: false },
};

/** Resize is still engaged during a transient letterboxed frame, so the icon
 *  continues to describe intent rather than flickering to fixed-size. */
export const ResizeTransient: Story = {
  args: { state: 'SCALED', syncEngaged: true },
};

/** No --key badge, no dev-server match — the bare host+path case. */
export const RawSession: Story = {
  args: { paneKey: '', devServerLabel: '', url: 'https://example.com/docs' },
};

/** Narrow header: the splits collapse first (≤420px), then nav (≤360px); the
 *  zoom/minimize/kill group rides on. */
export const Narrow: Story = {
  args: { width: 340 },
};

/** Real narrow split: the Tool context button leaves 102px for browser chrome,
 *  so the chrome sits behind one trigger while the whole zoom/minimize/kill
 *  group stays inline. */
export const TinyTool: Story = {
  args: { width: 126, tool: true, paneKey: 'a-very-long-tool-identity', devServerLabel: 'pnpm --filter a-very-long-project-name dev' },
};

/** Below 94px minimize/kill join the popover; zoom is the last control the
 *  header keeps. */
export const SmallestTool: Story = {
  args: { width: 110, tool: true },
};


export const DirtyTool: Story = { args: { tool: true, dirty: 'dirty' } };
// Clean and unknown render the same chrome; the tri-state is pinned by tool-state.test.ts.
export const CleanTool: Story = { args: { tool: true, dirty: 'clean' } };
// 118px leaves 94px of chrome — the tight band, where the dot is what pushes
// minimize/kill into the popover.
export const NarrowDirtyTool: Story = { args: { tool: true, dirty: 'dirty', width: 118 } };
