import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import type { DormouseTheme } from '../lib/themes';
import { OVERLAY_MAX_HEIGHT_VAR } from '../components/design';
import { SettingsDialog, TOPIC_GAP_PX } from '../components/SettingsDialog';
import { WorkspaceIdContext } from '../components/wall/wall-context';
import { enrolledStatus, UNENROLLED_STATUS } from '../host/remote/test-burrow-link';

/** The dialog renders into `document.body`, outside `canvasElement`
 *  (docs/specs/layout.md → "Selection overlay"), so play queries scope to the
 *  document body. */
function dialog(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body);
}

/**
 * The app-global Settings dialog, normally opened from the far right of the
 * baseboard. Rendering the dialog directly keeps these stories about its own
 * content — topics, search, and settings — rather
 * than about the button that opens it (`Baseboard.stories.tsx` covers that).
 * Everything below the theme row is driven by story `parameters`, since the
 * rule set, the settings, and the push-device list are app-global stores rather
 * than props.
 */
function DialogStory() {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open settings</button>
    {open && <WorkspaceIdContext.Provider value="settings-story">
      <SettingsDialog onClose={() => setOpen(false)} />
    </WorkspaceIdContext.Provider>}
  </>;
}

type Body = ReturnType<typeof dialog>;

function contentsButton(body: Body, name: string) {
  return within(body.getByRole('navigation', { name: 'Settings topics' })).getByRole('button', { name });
}

function selectTopic(name: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const body = dialog(canvasElement);
    await userEvent.click(contentsButton(body, name));
    await waitForTopicScroll(body.getByRole('region', { name }));
  };
}

/** Hovers a contents entry and waits out the smooth scroll it starts. */
async function hoverTopic(body: Body, name: string) {
  const button = contentsButton(body, name);
  await userEvent.hover(button);
  await waitForTopicScroll(body.getByRole('region', { name }));
  return button;
}

async function waitForTopicScroll(section: HTMLElement) {
  const content = section.parentElement!;
  await waitFor(() => {
    const desired = content.scrollTop + section.getBoundingClientRect().top - content.getBoundingClientRect().top - TOPIC_GAP_PX;
    const clamped = Math.max(0, Math.min(desired, content.scrollHeight - content.clientHeight));
    expect(Math.abs(content.scrollTop - clamped)).toBeLessThan(2);
  }, { timeout: 2000 });
}

const meta: Meta<typeof DialogStory> = {
  title: 'Modals/SettingsDialog',
  component: DialogStory,
  parameters: {
    primedWorkspaces: { workspaces: [{ id: 'settings-story', name: 'Development' }] },
  },
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
  play: selectTopic('Activity'),
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: {},
  },
};

/** The escape hatch: deferral off, so terminal notifications ring during animation. */
export const DeferralDisabled: Story = {
  parameters: {
    primedWatchedCommands: ['claude', 'codex'],
    primedAlertSettings: { deferAlertsUntilQuiet: false },
  },
  play: async ({ canvasElement }) => {
    await selectTopic('Activity')({ canvasElement });
    await dialog(canvasElement).findByRole('switch', {
      name: 'Defer alerts until animation stops off',
    });
  },
};

/** Fan-out: several phones have turned push on, so all of them are named. */
export const PushManyDevices: Story = {
  play: selectTopic('Notifications'),
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
  play: selectTopic('Notifications'),
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'ready', devices: [] },
  },
};

/** No Burrow service in this build at all — the website. Nothing renders below,
 *  so the copy must not point there. Paired with `PushNotEnrolled`. */
export const PushNoBurrow: Story = {
  play: selectTopic('Notifications'),
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'no-burrow', devices: [] },
  },
};

/**
 * The other `no-burrow`: a build that *does* have a Burrow service, which simply has
 * not enrolled. Same push status as `PushNoBurrow`, but here the Remote control
 * section renders beneath — so this is the one whose copy may say "below", and
 * the pair is what keeps that word honest.
 */
export const PushNotEnrolled: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
    primedPushDevices: { status: 'no-burrow', devices: [] },
    primedBurrow: { status: UNENROLLED_STATUS },
  },
  play: async ({ canvasElement }) => {
    await selectTopic('Notifications')({ canvasElement });
    await dialog(canvasElement).findByText(/Relay below to send push/);
  },
};

/**
 * Non-default timings, proving every number field renders the stored value
 * rather than a hardcoded one.
 */
export const CustomTimings: Story = {
  play: selectTopic('Notifications'),
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
 * A realistic accumulated rule set next to a long command name. A watch key is
 * a basename or `<runner> <script>`, so it is normally short, but nothing
 * enforces that — a pathological name must truncate instead of widening the
 * dialog.
 */
export const ManyRules: Story = {
  play: selectTopic('Activity'),
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

/**
 * The Notepad archive topic. Every host but Pocket has an
 * archive port, so the entry is present in every story here — this one is the
 * one that opens the Archive view in place rather
 * than stacking a second modal (`NotepadArchiveView.stories.tsx` covers the
 * view itself).
 */
export const NotepadArchiveEntry: Story = {
  parameters: {
    primedWatchedCommands: ['claude'],
    primedAlertSettings: {},
  },
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    await selectTopic('Notepad')({ canvasElement });
    await userEvent.click(await body.findByRole('button', { name: 'Open archive' }));
    await body.findByRole('button', { name: /Back to Settings/ });
  },
};

/** Opens the picker whose trigger matches `name`, inside the dialog.
 *
 *  Storybook's `play` runs before the snapshot, but the menu positions itself
 *  from a measured trigger rect — one commit later. Settle before returning so
 *  Chromatic never captures the pre-measurement frame. */
function openPickerMenu(name: RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(dialog(canvasElement).getByRole('button', { name }));
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
 * VS Code owns the theme; without a shell choice, General is omitted and
 * Activity becomes the first topic.
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
 * The Remote control section directly under the push
 * settings whose `no-burrow` copy points at it. Every other story here leaves
 * `primedBurrow` unset, which is a build with no Burrow service behind the
 * webview: the section renders nothing at all rather than offering a form the
 * build cannot honor (`docs/specs/relay.md`). `RemoteControlSection.stories`
 * covers its own states.
 */
export const WithRemoteControl: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ pairedClients: 1 }) },
    primedWatchedCommands: ['claude'],
    primedAlertSettings: { pushEnabled: true },
  },
  play: async ({ canvasElement }) => {
    await selectTopic('Notifications')({ canvasElement });
    await dialog(canvasElement).findByText('1 paired phone.');
  },
};

export const Activity: Story = {
  ...Default,
  play: selectTopic('Activity'),
};

export const Notifications: Story = {
  ...PushManyDevices,
};

export const Light: Story = {
  ...WithRules,
  globals: { theme: 'Light (Visual Studio)' },
};

export const Dark: Story = {
  ...WithRules,
  globals: { theme: 'Dark (Visual Studio)' },
};

export const Notepad: Story = {
  ...Default,
  play: selectTopic('Notepad'),
};

/** The same query finds settings in different topics, with their original copy. */
export const SearchAcrossTopics: Story = {
  ...WithRules,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    fireEvent.change(body.getByRole('searchbox'), { target: { value: 'terminal' } });
    await expect(body.getByRole('region', { name: 'Activity' })).toBeVisible();
    await expect(body.getByRole('region', { name: 'Notepad' })).toBeVisible();
    await expect(body.queryByRole('button', { name: /^Theme:/ })).not.toBeInTheDocument();
  },
};

export const SearchDescription: Story = {
  ...Default,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    fireEvent.change(body.getByRole('searchbox'), { target: { value: 'walked away' } });
    await expect(body.getByRole('textbox', { name: /Inactivity timeout:/ })).toBeVisible();
  },
};

export const SearchNoResults: Story = {
  ...Default,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    fireEvent.change(body.getByRole('searchbox'), { target: { value: 'unfindable' } });
    await expect(body.getByRole('status')).toHaveTextContent('No settings found.');
  },
};

export const ClickOutsideToClose: Story = {
  ...Default,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    const backdrop = body.getByRole('dialog').parentElement!;
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: body.getByRole('searchbox') },
      { keys: '[/MouseLeft]', target: backdrop },
    ]);
    await expect(body.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(backdrop);
    await expect(body.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(body.getByRole('button', { name: 'Open settings' }));
    await expect(body.getByRole('searchbox')).toHaveFocus();
  },
};

export const Narrow: Story = {
  ...WithRules,
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};

export const ShortViewport: Story = {
  ...PushManyDevices,
  render: () => <>
    <style>{`body { ${OVERLAY_MAX_HEIGHT_VAR.modal}: 20rem; }`}</style>
    <DialogStory />
  </>,
};

export const HoverContents: Story = {
  ...WithRules,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    const topic = await hoverTopic(body, 'Notifications');
    await expect(topic).toHaveAttribute('aria-current', 'location');
    await expect(body.getAllByRole('region')).toHaveLength(4);
  },
};

export const ScrollFollowsContents: Story = {
  ...WithRules,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    await userEvent.unhover(await hoverTopic(body, 'Notifications'));
    const section = body.getByRole('region', { name: 'Notepad' });
    const content = section.parentElement!;
    content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
    await waitForTopicScroll(section);
    await expect(contentsButton(body, 'Notepad')).toHaveAttribute('aria-current', 'location');
  },
};

export const HoverSettingsOverridesScroll: Story = {
  ...WithRules,
  play: async ({ canvasElement }) => {
    const body = dialog(canvasElement);
    const heading = body.getByRole('heading', { name: 'Activity' });
    const content = body.getByRole('region', { name: 'Activity' }).parentElement!;
    const scrollTop = content.scrollTop;
    await expect(contentsButton(body, 'General')).toHaveAttribute('aria-current', 'location');
    await userEvent.hover(heading);
    await expect(contentsButton(body, 'Activity')).toHaveAttribute('aria-current', 'location');
    await expect(content.scrollTop).toBe(scrollTop);
    await userEvent.unhover(heading);
    await expect(contentsButton(body, 'General')).toHaveAttribute('aria-current', 'location');
    await userEvent.hover(heading);
  },
};
