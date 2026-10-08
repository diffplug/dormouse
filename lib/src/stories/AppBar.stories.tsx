import type { Meta, StoryObj } from '@storybook/react';
import { AppBar } from '../../../standalone/src/AppBar';

/** The bar's strip reads the Workspace store, primed by the preview decorator
 *  from `parameters.primedWorkspaces` before first render and reset after. */
function AppBarStory() {
  return <div className="bg-app-bg" style={{ width: '100%' }}><AppBar /></div>;
}

/** `pinned` lists positions to pin; list them last, as the store keeps them. */
function primed(names: string[], pinned: number[] = []) {
  return {
    workspaces: names.map((name, index) => ({ id: `story-ws-${index + 1}`, name, ...(pinned.includes(index) ? { pinned: true } : {}) })),
  };
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

/** Pinned right: the pinned group sits flush against the bar's right end
 *  (before the window controls on Windows and Linux), the empty drag area
 *  between it and `+` (`docs/specs/layout.md` → "Workspace tabs"). */
export const PinnedRight: Story = {
  parameters: { primedWorkspaces: primed(['Workspace 1', 'Deploys', 'Notes', 'Scratch'], [2, 3]) },
};
