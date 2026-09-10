import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceStrip } from '../components/WorkspaceStrip';
import { WorkspaceWindow } from '../components/WorkspaceWindow';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import { resetWorkspaces, setWorkspaces } from '../lib/workspace-store';
import { requireElement, settleTerminals, waitForCondition } from './settle-terminals';

const WORKSPACES = [
  { id: 'story-window-1', name: 'Workspace 1' },
  { id: 'story-window-2', name: 'Deploys' },
];

/** The Window as the standalone host composes it: the strip in the bar, one
 *  mounted Wall per Workspace below it. */
function WorkspaceWindowStory() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setWorkspaces({ workspaces: WORKSPACES, activeId: WORKSPACES[0].id });
    setReady(true);
    return () => resetWorkspaces();
  }, []);

  if (!ready) return null;
  return (
    <div className="flex h-[520px] flex-col">
      <div className="bg-header-active-bg text-header-active-fg flex h-[30px] shrink-0 items-center">
        <WorkspaceStrip className="min-w-0 pl-2" />
      </div>
      <WorkspaceWindow initialPaneIds={['workspace-window-story']} />
    </div>
  );
}

const meta: Meta<typeof WorkspaceWindowStory> = {
  title: 'App/WorkspaceWindow',
  component: WorkspaceWindowStory,
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
};

export default meta;
type Story = StoryObj<typeof WorkspaceWindowStory>;

/**
 * Switching to the second Workspace: both Walls stay mounted in the same grid
 * cell, so the first one's terminal is still live behind the visible one and
 * never refits.
 */
export const TwoWorkspaces: Story = {
  play: async () => {
    await settleTerminals();
    const second = await requireElement<HTMLElement>(
      `[data-workspace-tab="${WORKSPACES[1].id}"] button`,
      'second workspace tab',
    );
    second.click();
    await waitForCondition(
      () => document.querySelector(`[data-workspace-wall="${WORKSPACES[1].id}"]`)
        ?.getAttribute('data-workspace-active') === 'true',
    );
    await settleTerminals();
  },
};
