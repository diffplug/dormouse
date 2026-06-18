import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AgentBrowserScreenModal } from '../components/wall/AgentBrowserScreenModal';
import type { RenderMode, ScreenController, ScreenSnapshot, ScreenState } from '../components/wall/agent-browser-screen';

interface StoryArgs {
  /** Render backend — `embed` greys out the Screen (viewport) section. */
  renderMode: RenderMode;
  /** Whether the host can pop out (gates the "Pop out to window" button). */
  canPopOut: boolean;
  state: ScreenState;
  /** Browser CSS viewport + inferred DPR. */
  vpW: number;
  vpH: number;
  vpDpr: number;
  /** Pane CSS size. */
  paneW: number;
  paneH: number;
  /** Dormouse window DPR. */
  displayDpr: number;
  syncEngaged: boolean;
  /** false ⇒ host can't drive the viewport (Tauri) ⇒ Apply disabled + note. */
  hostCapable: boolean;
}

// A standalone controller backed by a fixed snapshot — no registry, no live
// updates. `snapshot()` must return a stable reference for useSyncExternalStore,
// so it's memoised per args.
function useMockController(args: StoryArgs): ScreenController {
  return useMemo<ScreenController>(() => {
    const snapshot: ScreenSnapshot = {
      state: args.state,
      renderMode: args.renderMode,
      viewport: { w: args.vpW, h: args.vpH, dpr: args.vpDpr },
      paneCss: { w: args.paneW, h: args.paneH },
      displayDpr: args.displayDpr,
      syncEngaged: args.syncEngaged,
    };
    return {
      id: 'story',
      subscribe: () => () => {},
      snapshot: () => snapshot,
      subscribeChrome: () => () => {},
      chrome: () => ({
        url: 'http://localhost:5173/',
        displayUrl: 'localhost:5173',
        title: 'Vite + React',
        key: null,
      }),
      chromeActions: {
        navigate: (url) => console.log('[story] navigate', url),
        back: () => console.log('[story] back'),
        forward: () => console.log('[story] forward'),
        reload: () => console.log('[story] reload'),
      },
      hostCapable: args.hostCapable,
      canPopOut: args.canPopOut,
      actions: {
        engageSync: () => console.log('[story] engageSync'),
        applyDevice: (name) => console.log('[story] applyDevice', name),
        applyViewport: (w, h, dpr) => console.log('[story] applyViewport', w, h, dpr),
        openModal: () => {},
        setRenderMode: (mode) => console.log('[story] setRenderMode', mode),
      },
    };
  }, [args.state, args.renderMode, args.vpW, args.vpH, args.vpDpr, args.paneW, args.paneH, args.displayDpr, args.syncEngaged, args.hostCapable, args.canPopOut]);
}

function AgentBrowserScreenModalStory(args: StoryArgs) {
  const controller = useMockController(args);
  return (
    <div className="relative h-[560px] w-[760px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      <div className="p-4 text-sm text-muted">agent-browser surface — click the SYNCED/SCALED chip to open this.</div>
      <AgentBrowserScreenModal controller={controller} label="surface:3" onClose={() => console.log('[story] close')} />
    </div>
  );
}

const meta: Meta<typeof AgentBrowserScreenModalStory> = {
  title: 'Modals/AgentBrowserScreenModal',
  component: AgentBrowserScreenModalStory,
  argTypes: {
    renderMode: { control: 'inline-radio', options: ['ab-screencast', 'ab-popout', 'iframe'] },
    canPopOut: { control: 'boolean' },
    state: { control: 'inline-radio', options: ['SYNCED', 'SCALED'] },
    vpW: { control: 'number' },
    vpH: { control: 'number' },
    vpDpr: { control: 'number' },
    paneW: { control: 'number' },
    paneH: { control: 'number' },
    displayDpr: { control: 'number' },
    syncEngaged: { control: 'boolean' },
    hostCapable: { control: 'boolean' },
  },
  // Defaults shared by every story (each story overrides the viewport knobs);
  // a swap-capable, pop-out-capable surface so both new affordances show.
  args: {
    renderMode: 'ab-screencast',
    canPopOut: true,
  },
};

export default meta;
type Story = StoryObj<typeof AgentBrowserScreenModalStory>;

// Synced + matching ⇒ pre-selects "Sync to pane".
export const Synced: Story = {
  args: {
    state: 'SYNCED',
    vpW: 980, vpH: 560, vpDpr: 2,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: true,
    hostCapable: true,
  },
};

// Scaled (an external `set viewport` took over) ⇒ pre-selects Custom, prefilled
// with the live browser dims.
export const ScaledCustom: Story = {
  args: {
    state: 'SCALED',
    vpW: 1280, vpH: 720, vpDpr: 1,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: false,
    hostCapable: true,
  },
};

// A phone-emulating viewport (e.g. after `set device "iPhone 16"`). Still
// pre-selects Custom (devices can't be pre-matched without a dims map), but the
// Device list is the obvious next pick.
export const PhoneViewport: Story = {
  args: {
    state: 'SCALED',
    vpW: 393, vpH: 852, vpDpr: 3,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: false,
    hostCapable: true,
  },
};

// Host can't drive the viewport (Tauri) ⇒ Apply is disabled and a note points
// the user at `dor ab set …`.
export const HostIncapable: Story = {
  args: {
    state: 'SCALED',
    vpW: 1280, vpH: 720, vpDpr: 1,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: false,
    hostCapable: false,
  },
};

// Pop-out render mode: same agent-browser as a native OS window. The Render
// section pre-selects Pop-out and the Screen section greys out (the window owns
// its own size).
export const Popout: Story = {
  args: {
    renderMode: 'ab-popout',
    state: 'SYNCED',
    vpW: 980, vpH: 560, vpDpr: 2,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: true,
    hostCapable: true,
  },
};

// Embed (iframe) render mode: the Render section pre-selects Embed and the
// Screen (viewport) section greys out — the iframe renders at the pane size, so
// there's nothing to set.
export const EmbedRender: Story = {
  args: {
    renderMode: 'iframe',
    state: 'SYNCED',
    vpW: 980, vpH: 560, vpDpr: 2,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: true,
    hostCapable: true,
  },
};

// Host can't pop out (e.g. the web host) ⇒ the Render section drops the Pop-out
// option, leaving Screencast / Embed.
export const NoPopOut: Story = {
  args: {
    canPopOut: false,
    state: 'SYNCED',
    vpW: 980, vpH: 560, vpDpr: 2,
    paneW: 980, paneH: 560,
    displayDpr: 2,
    syncEngaged: true,
    hostCapable: true,
  },
};
