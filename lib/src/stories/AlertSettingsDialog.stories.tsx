import type { Meta, StoryObj } from '@storybook/react';
import { AlertSettingsDialog } from '../components/AlertSettingsDialog';

/**
 * The app-global Alarm settings, normally opened from the far right of the
 * baseboard. Rendering the dialog directly keeps these stories about its own
 * content — the rule list and the three settings groups — rather than about the
 * button that opens it (`Baseboard.stories.tsx` covers that). Everything here is
 * driven by story `parameters`, since the rule set, the settings, and the
 * push-device list are app-global stores rather than props.
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
 * Push on, with one subscribed phone — the mockup's "Push will be sent to …"
 * case. The device line is the join of the server's subscriptions and the
 * Host's ACL labels, so a story has to prime it directly.
 */
export const PushEnabled: Story = {
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: {
      status: 'ready',
      devices: [{ devicePublicKey: 'device-1', label: 'iPhone Safari' }],
    },
  },
};

/** Fan-out: several devices have enabled alerts, so all of them are named. */
export const PushManyDevices: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: {
      status: 'ready',
      devices: [
        { devicePublicKey: 'device-1', label: 'iPhone Safari' },
        { devicePublicKey: 'device-2', label: 'iPad' },
        { devicePublicKey: 'device-3', label: 'Pixel Chrome' },
      ],
    },
  },
};

/**
 * Push on but nothing subscribed — the state a user lands in before installing
 * Pocket to their Home Screen. It must say so rather than look broken.
 */
export const PushNoDevices: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'ready', devices: [] },
  },
};

/** No remote Host at all — the ordinary case for a machine that never enrolled. */
export const PushNoHost: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'no-host', devices: [] },
  },
};

/**
 * Non-default timings, proving every number field renders the stored value
 * rather than a hardcoded one.
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
