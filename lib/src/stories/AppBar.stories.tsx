import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AppBar } from '../../../standalone/src/AppBar';
import { resetWorkspaces, setWorkspaces } from '../lib/workspace-store';

function AppBarStory({ names }: { names: string[] }) {
  // The bar's strip reads the Workspace store, so the scenario is written before
  // first paint and reset after.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const workspaces = names.map((name, index) => ({ id: `story-ws-${index + 1}`, name }));
    setWorkspaces({ workspaces, activeId: workspaces[0].id });
    setReady(true);
    return () => resetWorkspaces();
  }, [names]);

  return <div style={{ width: '100%' }}>{ready && <AppBar />}</div>;
}

const meta: Meta<typeof AppBarStory> = {
  title: 'Components/AppBar',
  component: AppBarStory,
};

export default meta;
type Story = StoryObj<typeof AppBarStory>;

/** The left slot holds the Workspace strip; shell and theme selection live in
 *  the Settings dialog (`Modals/SettingsDialog`). */
export const Default: Story = {
  args: { names: ['Workspace 1', 'Deploys', 'Agents'] },
};

/** One Workspace: no close button anywhere, because the last one cannot close. */
export const SingleWorkspace: Story = {
  args: { names: ['Workspace 1'] },
};
