import type { Meta, StoryObj } from '@storybook/react';
import { AlertSettingsDialog } from '../components/AlertSettingsDialog';

/**
 * The app-global Alarm settings, normally opened from the far right of the
 * baseboard. Rendering the dialog directly keeps these stories about its own
 * content — the rule list, the two live settings, and the disabled push group —
 * rather than about the button that opens it (`Baseboard.stories.tsx` covers
 * that). Everything here is driven by story `parameters`, since the rule set and
 * the settings are app-global stores rather than props.
 */
function DialogStory() {
  return <AlertSettingsDialog onClose={() => {}} />;
}

const meta: Meta<typeof DialogStory> = {
  title: 'Modals/AlertSettingsDialog',
  component: DialogStory,
};

export default meta;
type Story = StoryObj<typeof DialogStory>;

/**
 * A fresh install: no rules yet, speech off. The empty state has to explain how
 * rules get created, because they cannot be added from this dialog — WATCHING is
 * keyed on a running command, so `a` in that tab is the only way in.
 */
export const Default: Story = {
  parameters: {
    primedWatchedCommands: [],
    primedAlertSettings: {},
  },
};

/** The mockup's case: rules accumulated, defaults otherwise. */
export const WithRules: Story = {
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: {},
  },
};

/**
 * Speech on. The delay field below it goes from dimmed-and-disabled to live,
 * which is the only visual difference between this and `WithRules`.
 */
export const SpeechEnabled: Story = {
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: { speakEnabled: true },
  },
};

/**
 * Non-default timings, proving both number fields render the stored value rather
 * than a hardcoded one. Push stays greyed regardless of what its fields hold.
 */
export const CustomTimings: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: {
      inactivityTimeoutMs: 45_000,
      speakEnabled: true,
      speakDelayMs: 5_000,
      pushDelayMs: 90_000,
    },
  },
};

/**
 * A realistic accumulated rule set next to a long command name. argv0 is a
 * basename so it is normally short, but nothing enforces that — a pathological
 * name must truncate instead of widening the dialog.
 */
export const ManyRules: Story = {
  parameters: {
    primedWatchedCommands: [
      'cargo',
      'claude',
      'codex',
      'docker',
      'pnpm',
      'pytest',
      'really-long-generated-integration-test-runner-name.sh',
      'tsc',
    ],
    primedAlertSettings: { speakEnabled: true },
  },
};
