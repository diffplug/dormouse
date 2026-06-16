import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AgentBrowserScreenModal } from '../components/wall/AgentBrowserScreenModal';
import type { ScreenController, ScreenSnapshot, ScreenState } from '../components/wall/agent-browser-screen';

interface StoryArgs {
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
        connection: 'connected',
      }),
      chromeActions: {
        back: () => console.log('[story] back'),
        forward: () => console.log('[story] forward'),
        reload: () => console.log('[story] reload'),
      },
      hostCapable: args.hostCapable,
      actions: {
        engageSync: () => console.log('[story] engageSync'),
        applyDevice: (name) => console.log('[story] applyDevice', name),
        applyViewport: (w, h, dpr) => console.log('[story] applyViewport', w, h, dpr),
        openModal: () => {},
      },
    };
  }, [args.state, args.vpW, args.vpH, args.vpDpr, args.paneW, args.paneH, args.displayDpr, args.syncEngaged, args.hostCapable]);
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
