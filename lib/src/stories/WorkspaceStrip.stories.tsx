import { setWorkspaceMoveError } from '../lib/workspace-ui-store';
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
function StripStory({ width = 640, busyIndex, todoLabels }: {
  width?: number;
  busyIndex?: number;
  /** By position: what a Workspace's TODO pill says its click selects. */
  todoLabels?: Record<number, string>;
}) {
  // Stand-ins for mounted Walls: the close flow asks one about running work, and
  // a TODO pill asks where its click lands. `closeAll` never resolves: the story
  // is the confirmation, not what follows it.
  useEffect(() => {
    const indices = new Set([...(busyIndex === undefined ? [] : [busyIndex]), ...Object.keys(todoLabels ?? {}).map(Number)]);
    const releases = [...indices].map((index) => {
      const label = todoLabels?.[index];
      return registerWallHandle(stubWallHandle(ws(index), {
        ...(index === busyIndex ? {
          hasTouchedSurfaces: () => true,
          runningCount: () => 1,
          closeAll: () => new Promise<null>(() => {}),
        } : {}),
        ...(label === undefined ? {} : { peekNextTodo: () => ({ id: `${ws(index)}-todo`, label }) }),
      }));
    });
    return () => releases.forEach((release) => release());
  }, [busyIndex, todoLabels]);

  return (
    <div className="bg-app-bg text-app-fg flex h-[30px] items-end" style={{ width }}>
      <WorkspaceStrip className="min-w-0 pl-1.75" />
    </div>
  );
}

const meta: Meta<typeof StripStory> = {
  title: 'Components/WorkspaceStrip',
  component: StripStory,
};

export default meta;
type Story = StoryObj<typeof StripStory>;

/** Content-sized tabs share the Door geometry and use the pane-header palettes. */
export const Default: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
};

export const ContentSized: Story = {
  parameters: { primedWorkspaces: primed(['App', 'Agents', 'Release pipeline', 'Docs'], 0) },
};

/** Every tab shows its Workspace's TODO pill; only a HIDDEN one wears the alarm
 *  inset, the visible one's panes already ringing (`docs/specs/alert.md` → the
 *  Workspace union). The pill is a borderless button: hover it for the wash and
 *  the Surface its click selects (`docs/specs/layout.md` → Workspace tabs). */
export const Indicators: Story = {
  args: { todoLabels: { 0: 'vim notes.md', 1: 'claude', 2: 'pnpm dev' } },
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
        // The visible Workspace owes attention too: its TODO pill, no inset.
        'visible-a': { status: 'ALERT_RINGING', todo: true },
      },
    },
  },
  play: () => waitForPrimedState(),
};

export const Renaming: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
  play: async () => {
    const tab = await requireElement<HTMLElement>('[data-workspace-tab-active="true"] button', 'active workspace tab');
    tab.click();
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


export const MoveRefused: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys'], 1) },
  play: async () => {
    await requireElement('[data-workspace-tab]', 'workspace tab');
    setWorkspaceMoveError({ id: ws(1), reason: 'Approve or decline pending Tools before moving this Workspace' });
    await requireElement('#workspace-move-error', 'move refusal');
  },
};
