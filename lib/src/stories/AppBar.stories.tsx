import type { Meta, StoryObj } from '@storybook/react';
import { AppBar } from '../../../standalone/src/AppBar';

function AppBarStory() {
  return (
    <div style={{ width: '100%' }}>
      <AppBar />
    </div>
  );
}

const meta: Meta<typeof AppBarStory> = {
  title: 'Components/AppBar',
  component: AppBarStory,
};

export default meta;
type Story = StoryObj<typeof AppBarStory>;

/** The left slot holds the `[New workspace]` placeholder; shell selection lives
 *  in the Settings dialog (`Modals/SettingsDialog`). No play fn clicks the
 *  button — it opens the tracking issue externally. */
export const Default: Story = {};
