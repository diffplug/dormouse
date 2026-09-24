import type { Meta, StoryObj } from '@storybook/react';
import { AlertRingIndicator } from '../components/wall/AlertRingIndicator';

const SESSION_ID = 'ring-indicator-story';

/** Every row of the treatment needs a latched ring under it; speech only labels it. */
const RINGING = { byId: { [SESSION_ID]: { status: 'ALERT_RINGING' as const } } };

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
        <AlertRingIndicator sessionId={SESSION_ID} />
      </div>
    </div>
  );
}

const meta: Meta<typeof IndicatorStory> = {
  title: 'Components/AlertRingIndicator',
  component: IndicatorStory,
};

export default meta;
type Story = StoryObj<typeof IndicatorStory>;

// `cfg.alert.ringingPaused` is on under Chromatic (lib/.storybook/preview.ts), so
// the arrival burst is frozen out and this snapshots as the static treatment.
export const Ringing: Story = {
  parameters: {
    primedSessionState: RINGING,
  },
};

export const Speaking: Story = {
  parameters: {
    primedSessionState: RINGING,
    primedAlertSpeech: { [SESSION_ID]: 'speaking' },
  },
};

export const HasSpoken: Story = {
  parameters: {
    primedSessionState: RINGING,
    primedAlertSpeech: { [SESSION_ID]: 'spoken' },
  },
};
