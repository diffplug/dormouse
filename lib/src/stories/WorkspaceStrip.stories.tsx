import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceStrip } from '../components/WorkspaceStrip';
import { registerWallHandle, stubWallHandle } from '../components/wall/wall-handles';
import { requireElement, waitForPrimedState } from './settle-terminals';

/** Workspace ids by position, so `parameters.primedWorkspaces` and the story's
 *  membership and stub handle all name the same ones. */
const ws = (index: number) => `story-ws-${index + 1}`;

function primed(names: string[], activeIndex: number, membership?: Record<number, string[]>) {
  return {
    workspaces: names.map((name, index) => ({ id: ws(index), name })),
    activeId: ws(activeIndex),
    membership: Object.fromEntries(
      Object.entries(membership ?? {}).map(([index, ids]) => [ws(Number(index)), ids]),
    ),
  };
}

/** The Workspace model comes from `parameters.primedWorkspaces`, which the
 *  preview decorator writes before first render (the strip reads the store on
 *  its first) and clears after. */
function StripStory({ width = 640, busyIndex }: { width?: number; busyIndex?: number }) {
  // A stand-in for a mounted Wall, so the close flow has something to ask about
  // running work. `closeAll` never resolves: the story is the confirmation, not
  // what follows it.
  useEffect(() => {
    if (busyIndex === undefined) return;
    return registerWallHandle(stubWallHandle(ws(busyIndex), {
      hasTouchedSurfaces: () => true,
      runningCount: () => 1,
      closeAll: () => new Promise<null>(() => {}),
    }));
  }, [busyIndex]);

  return (
    <div className="bg-header-active-bg text-header-active-fg flex h-[30px] items-center" style={{ width }}>
      <WorkspaceStrip className="min-w-0 pl-2" />
    </div>
  );
}

const meta: Meta<typeof StripStory> = {
  title: 'Components/WorkspaceStrip',
  component: StripStory,
};

export default meta;
type Story = StoryObj<typeof StripStory>;

/** Two Workspaces, the second active: the active tab takes the wall's own
 *  background and the terminal top radius, the other is transparent. */
export const Default: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
};

/** Only a HIDDEN Workspace shows indicators — the visible one's panes already
 *  say it (`docs/specs/alert.md` → the Workspace union). */
export const Indicators: Story = {
  parameters: {
    primedWorkspaces: primed(['Builds', 'Agents', 'Workspace 3'], 2, {
      0: ['builds-a', 'builds-b'],
      1: ['agents-a'],
      2: ['visible-a'],
    }),
    // Applied two frames after mount by the preview decorator, which clears
    // Activity for every session-less id first.
    primedSessionState: {
      byId: {
        'builds-a': { status: 'ALERT_RINGING' },
        'builds-b': { todo: true },
        'agents-a': { todo: true },
        // The visible Workspace owes attention too, and still shows nothing.
        'visible-a': { status: 'ALERT_RINGING', todo: true },
      },
    },
  },
  play: () => waitForPrimedState(),
};

export const Renaming: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
  play: async () => {
    const tab = await requireElement<HTMLElement>('[data-workspace-tab] button', 'workspace tab');
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await requireElement('[data-workspace-rename-for]', 'rename editor');
  },
};

/** Past the point where tabs still fit: they shrink toward the floor and the
 *  strip scrolls. No overflow arrows. */
export const Overflow: Story = {
  args: { width: 420 },
  parameters: {
    primedWorkspaces: primed(['Workspace 1', 'Deploys', 'Agents', 'Builds', 'Docs', 'Scratch'], 3),
  },
};

/** Closing a Workspace that holds work asks first; with no Window behind it the
 *  confirmation is viewport-centered. */
export const CloseConfirm: Story = {
  args: { busyIndex: 1 },
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
  play: async () => {
    const close = await requireElement<HTMLButtonElement>(
      '[data-workspace-tab-active="true"] [data-workspace-tab-close]',
      'close button',
    );
    close.click();
    await requireElement('#kill-confirm-title', 'kill confirmation');
  },
};
