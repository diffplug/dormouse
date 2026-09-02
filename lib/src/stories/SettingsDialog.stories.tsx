import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import type { DormouseTheme } from '../lib/themes';
import { SettingsDialog } from '../components/SettingsDialog';
import { enrolledStatus, UNENROLLED_STATUS } from '../host/remote/test-remote-host-link';

/**
 * The app-global Settings dialog, normally opened from the far right of the
 * baseboard. Rendering the dialog directly keeps these stories about its own
 * content — the theme row, the rule list, and the three alarm groups — rather
 * than about the button that opens it (`Baseboard.stories.tsx` covers that).
 * Everything below the theme row is driven by story `parameters`, since the
 * rule set, the settings, and the push-device list are app-global stores rather
 * than props.
 */
function DialogStory() {
  return <SettingsDialog onClose={() => {}} />;
}

const meta: Meta<typeof DialogStory> = {
  title: 'Modals/SettingsDialog',
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

/** The animation watcher gates terminal-notification alerts. */
export const DeferralEnabled: Story = {
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: { deferAlertsUntilQuiet: true },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('switch', {
      name: 'Defer alerts until animation stops on',
    });
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
      devices: [{ label: 'iPhone Safari' }],
    },
  },
};

/** Fan-out: several phones have turned push on, so all of them are named. */
export const PushManyDevices: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: {
      status: 'ready',
      devices: [
        { label: 'iPhone Safari' },
        { label: 'iPad' },
        { label: 'Pixel Chrome' },
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

/** No Host service in this build at all — the website. Nothing renders below,
 *  so the copy must not point there. Paired with `PushNotEnrolled`. */
export const PushNoHost: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'no-host', devices: [] },
  },
};

/**
 * The other `no-host`: a build that *does* have a Host service, which simply has
 * not enrolled. Same push status as `PushNoHost`, but here the Remote control
 * section renders beneath — so this is the one whose copy may say "below", and
 * the pair is what keeps that word honest.
 */
export const PushNotEnrolled: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'no-host', devices: [] },
    primedRemoteHost: { status: UNENROLLED_STATUS },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/server below to send push/);
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

/** Opens the picker whose trigger matches `name`.
 *
 *  Storybook's `play` runs before the snapshot, but the menu positions itself
 *  from a measured trigger rect — one commit later. Settle before returning so
 *  Chromatic never captures the pre-measurement frame. The dialog renders in a
 *  portal-less overlay above `canvasElement`, so scope to the document body. */
function openPickerMenu(name: RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
}

/**
 * The theme dropdown open. It renders `position: fixed` off the trigger rect
 * rather than absolutely, because the dialog surface is `overflow-y-auto` and
 * would otherwise clip the menu (`docs/specs/theme.md`).
 */
export const ThemeMenuOpen: Story = {
  parameters: {
    primedWatchedCommands: [],
    primedAlertSettings: {},
  },
  play: openPickerMenu(/^Theme:/),
};

/**
 * The same menu with enough themes to overflow. The viewport clamp is what
 * keeps a long list from running off the bottom of the window — it is
 * `position: fixed`, so anything below the fold would be unreachable.
 */
export const ThemeMenuOpenWithInstalledThemes: Story = {
  parameters: {
    primedWatchedCommands: [],
    primedAlertSettings: {},
    primedInstalledThemes: Array.from({ length: 10 }, (_, index): DormouseTheme => ({
      id: `storybook.installed-${index}`,
      label: `Installed Theme ${index}`,
      type: 'dark',
      swatch: '#2f3b47',
      accent: '#7fb4d8',
      vars: {},
      origin: {
        kind: 'installed',
        extensionId: `storybook/theme-${index}`,
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    })),
  },
  play: openPickerMenu(/^Theme:/),
};

/**
 * The VS Code host: it owns the theme and has its own picker, so the Theme row
 * is absent (`hostOwnsTheme`, docs/specs/theme.md). The rule list becomes the
 * first section again and must drop its divider — a stray top border here is
 * the visible symptom of that conditional going wrong.
 */
export const HostOwnsTheme: Story = {
  parameters: {
    hostOwnsTheme: true,
    primedWatchedCommands: ['claude'],
    primedAlertSettings: {},
  },
};

/** The shells a standalone host detects, seeded into the shell store the way
 *  `main.tsx` does at boot. */
const DEFAULT_SHELLS = [
  { name: 'zsh', path: '/bin/zsh' },
  { name: 'bash', path: '/bin/bash' },
  { name: 'fish', path: '/opt/homebrew/bin/fish' },
];

/**
 * Standalone with several shells detected: the Shell row joins the Theme row,
 * grouped with it rather than divided from it. Below two shells there is
 * nothing to switch between and the row is absent, which is why every other
 * story here has no Shell row.
 */
export const ShellRow: Story = {
  parameters: {
    primedShells: DEFAULT_SHELLS,
    primedWatchedCommands: ['claude'],
    primedAlertSettings: {},
  },
};

/**
 * The shell dropdown open, with the selected row's check. Positioned `fixed`
 * off the trigger rect for the same reason the theme menu is.
 */
export const ShellMenuOpen: Story = {
  parameters: {
    primedShells: DEFAULT_SHELLS,
    primedWatchedCommands: [],
    primedAlertSettings: {},
  },
  play: openPickerMenu(/^Shell:/),
};

/**
 * The VS Code host again: its native `dormouse.selectShell` QuickPick owns the
 * shell, so the row is absent despite shells being seeded (`hostOwnsShells`).
 */
export const HostOwnsShells: Story = {
  parameters: {
    hostOwnsShells: true,
    primedShells: DEFAULT_SHELLS,
    primedWatchedCommands: ['claude'],
    primedAlertSettings: {},
  },
};

/**
 * The Remote control section in place — last, and directly under the push
 * settings whose `no-host` copy points at it. Every other story here leaves
 * `primedRemoteHost` unset, which is a build with no Host service behind the
 * webview: the section renders nothing at all rather than offering a form the
 * build cannot honor (`docs/specs/server.md`). `RemoteControlSection.stories`
 * covers its own states.
 */
export const WithRemoteControl: Story = {
  parameters: {
    primedRemoteHost: { status: enrolledStatus({ pairedClients: 1 }) },
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('1 paired phone.');
  },
};
