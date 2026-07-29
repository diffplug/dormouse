import type { Meta, StoryObj } from '@storybook/react';
import { AlertSpeechIndicator } from '../components/wall/AlertSpeechIndicator';

const SESSION_ID = 'speech-indicator-story';

function IndicatorStory() {
  return (
    <div className="bg-app-bg p-8">
      <div className="relative flex h-64 max-w-3xl flex-col overflow-hidden rounded-lg">
        <div className="flex h-[30px] shrink-0 items-center rounded-t-lg bg-header-inactive-bg px-2 text-sm font-mono text-header-inactive-fg">
          build-server
        </div>
        <div className="min-h-0 flex-1 rounded-b-lg bg-terminal-bg p-3 text-sm font-mono text-terminal-fg">
          $ pnpm build
          <br />
          Build completed successfully.
        </div>
        <AlertSpeechIndicator sessionId={SESSION_ID} />
      </div>
    </div>
  );
}

const meta: Meta<typeof IndicatorStory> = {
  title: 'Components/AlertSpeechIndicator',
  component: IndicatorStory,
};

export default meta;
type Story = StoryObj<typeof IndicatorStory>;

export const Speaking: Story = {
  parameters: {
    primedAlertSpeech: { [SESSION_ID]: 'speaking' },
  },
};

export const HasSpoken: Story = {
  parameters: {
    primedAlertSpeech: { [SESSION_ID]: 'spoken' },
  },
};
