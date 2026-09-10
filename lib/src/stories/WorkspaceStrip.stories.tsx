import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceStrip } from '../components/WorkspaceStrip';
import { registerWallHandle, resetWallHandles, type WallHandle } from '../components/wall/wall-handles';
import { setTerminalActivity } from '../lib/terminal-registry';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { resetWorkspaces, setWorkspaces } from '../lib/workspace-store';
import { requireElement } from './settle-terminals';

/** A stand-in for a mounted Wall, so the strip's close flow has something to
 *  ask about running work without a live Workspace behind it. */
function stubHandle(workspaceId: string): WallHandle {
  return {
    workspaceId,
    surfaceIds: () => [],
    ownsSurface: () => false,
    hasTouchedSurfaces: () => true,
    runningCount: () => 1,
    serialize: async () => ({ version: 3, panes: [], doors: [] }),
    flushPersistence: async () => {},
    focusSelected: () => {},
    // Never resolves: the story is the confirmation, not what follows it.
    closeAll: () => new Promise<null>(() => {}),
    handleDorControl: () => {},
  };
}

/** Activity primed onto a Workspace's member Surfaces, keyed by tab index. */
type IndicatorSpec = Record<number, { ringing?: boolean; todo?: boolean; extraTodos?: number }>;

function StripStory({
  names,
  activeIndex = 0,
  indicators,
  busyIndex,
  width = 640,
}: {
  names: string[];
  activeIndex?: number;
  indicators?: IndicatorSpec;
  busyIndex?: number;
  width?: number;
}) {
  // The strip reads module stores, so the scenario is written before first paint
  // and torn down after — a story must not leak Workspaces into the next one.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const ids = names.map((_, index) => `story-ws-${index + 1}`);
    setWorkspaces({
      workspaces: names.map((name, index) => ({ id: ids[index], name })),
      activeId: ids[activeIndex],
    });
    resetWorkspaceSurfaces();
    resetWallHandles();
    for (const [index, spec] of Object.entries(indicators ?? {})) {
      const id = ids[Number(index)];
      const surfaces = [
        `${id}-a`,
        ...Array.from({ length: spec.extraTodos ?? 0 }, (_, n) => `${id}-todo-${n}`),
      ];
      setWorkspaceSurfaces(id, surfaces);
      setTerminalActivity(surfaces[0], {
        status: spec.ringing ? 'ALERT_RINGING' : 'WATCHING_DISABLED',
        todo: spec.todo === true,
      });
      for (const extra of surfaces.slice(1)) setTerminalActivity(extra, { todo: true });
    }
    if (busyIndex !== undefined) registerWallHandle(stubHandle(ids[busyIndex]));
    setReady(true);
    return () => {
      resetWorkspaces();
      resetWorkspaceSurfaces();
      resetWallHandles();
    };
  }, [names, activeIndex, indicators, busyIndex]);

  return (
    <div className="bg-header-active-bg text-header-active-fg flex h-[30px] items-center" style={{ width }}>
      {ready && <WorkspaceStrip className="min-w-0 pl-2" />}
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
  args: { names: ['Workspace 1', 'Deploys'], activeIndex: 1 },
};

/** Only a HIDDEN Workspace shows indicators — the visible one's panes already
 *  say it (`docs/specs/alert.md` → the Workspace union). */
export const Indicators: Story = {
  args: {
    names: ['Builds', 'Agents', 'Workspace 3'],
    activeIndex: 2,
    indicators: { 0: { ringing: true, extraTodos: 1 }, 1: { todo: true } },
  },
};

export const Renaming: Story = {
  args: { names: ['Workspace 1', 'Deploys'], activeIndex: 1 },
  play: async () => {
    const tab = await requireElement<HTMLElement>('[data-workspace-tab] button', 'workspace tab');
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await requireElement('[data-workspace-rename-for]', 'rename editor');
  },
};

/** Past the point where tabs still fit: they shrink toward the floor and the
 *  strip scrolls. No overflow arrows. */
export const Overflow: Story = {
  args: {
    names: ['Workspace 1', 'Deploys', 'Agents', 'Builds', 'Docs', 'Scratch'],
    activeIndex: 3,
    width: 420,
  },
};

/** Closing a Workspace that holds work asks first, anchored to its own tab. */
export const CloseConfirm: Story = {
  args: { names: ['Workspace 1', 'Deploys'], activeIndex: 1, busyIndex: 1 },
  play: async () => {
    const close = await requireElement<HTMLButtonElement>(
      '[data-workspace-tab-active="true"] [data-workspace-tab-close]',
      'close button',
    );
    close.click();
    await requireElement('#kill-confirm-title', 'kill confirmation');
  },
};
