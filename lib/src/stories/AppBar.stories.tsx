import type { Meta, StoryObj } from '@storybook/react';
import { AppBar } from '../../../standalone/src/AppBar';

/** The bar's strip reads the Workspace store, primed by the preview decorator
 *  from `parameters.primedWorkspaces` before first render and reset after. */
function AppBarStory() {
  return <div style={{ width: '100%' }}><AppBar /></div>;
}

function primed(names: string[]) {
  return { workspaces: names.map((name, index) => ({ id: `story-ws-${index + 1}`, name })) };
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
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys', 'Agents']) },
};

/** One Workspace: no close button anywhere, because the last one cannot close. */
export const SingleWorkspace: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1']) },
};
