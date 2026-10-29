import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Baseboard } from '../components/Baseboard';
import { TOPIC_GAP_PX } from '../components/SettingsDialog';
import { WorkspaceIdContext } from '../components/wall/wall-context';
import type { DoorChip } from '../components/Wall';
import { createTerminalPaneState, type TerminalPaneState } from '../lib/terminal-state';
import type { AlarmUpsell } from '../lib/alarm-upsell';
import { getNetworkPolicySnapshot } from '../remote/burrow/network-policy-store';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { enrolledStatus, SELF_HOST_UNENROLLED_STATUS, UNENROLLED_STATUS } from '../host/remote/test-burrow-link';
import { waitForPrimedState } from './settle-terminals';

const BASE_TIME = 1_700_000_000_000;

const makeItem = (id: string, title: string): DoorChip => ({
  id,
  title,
  kind: 'terminal',
});

function withState(items: DoorChip[], byId: Record<string, Record<string, unknown>>) {
  return {
    primedSessionState: {
      byId,
    },
    primedTerminalState: {
      byId: Object.fromEntries(items.map((item, index) => [item.id, userTitleState(item.title, index)])),
    },
  };
}

function userTitleState(title: string, index: number): TerminalPaneState {
  return createTerminalPaneState({
    titleCandidates: {
      user: { title, source: 'user', updatedAt: BASE_TIME + index },
    },
  });
}

function BaseboardStory({ items, notice }: { items: DoorChip[]; notice?: ReactNode }) {
  return (
    <div className="bg-app-bg" style={{ width: '100%' }}>
      <Baseboard
        items={items}
        notice={notice}
        onReattach={(item) => console.log('Reattach:', item.id)}
      />
    </div>
  );
}

const meta: Meta<typeof BaseboardStory> = {
  title: 'Components/Baseboard',
  component: BaseboardStory,
};

export default meta;
type Story = StoryObj<typeof BaseboardStory>;

const oneRingingDoorItems = [makeItem('surface:1', 'build-server')];
const mixedDoorStateItems = [
  makeItem('surface:1', 'dev-server'),
  makeItem('surface:2', 'test-runner'),
  makeItem('surface:3', 'logs'),
  makeItem('surface:4', 'notarization'),
];
const overflowWithRingingDoorItems = [
  makeItem('surface:1', 'frontend-dev'),
  makeItem('surface:2', 'backend-api'),
  makeItem('surface:3', 'database-migrations'),
  makeItem('surface:4', 'test-runner'),
  makeItem('surface:5', 'log-aggregator'),
  makeItem('surface:6', 'build-pipeline'),
  makeItem('surface:7', 'monitoring'),
  makeItem('surface:8', 'linter'),
];
const extremeTitleWithBothIndicatorsItems = [
  makeItem('surface:1', 'short'),
  makeItem('surface:2', 'my-extremely-long-running-background-process-with-a-very-descriptive-name'),
  makeItem('surface:3', 'another'),
];
const browserSurfaceItems: DoorChip[] = [
  { id: 'surface:1', kind: 'browser', title: 'localhost:5173/app', browserDisplay: 'agent-browser-resize' },
  { id: 'surface:2', kind: 'browser', title: 'mobile checkout', browserDisplay: 'agent-browser-fixed' },
  { id: 'surface:3', kind: 'browser', title: 'docs.example.com', browserDisplay: 'agent-browser-popout' },
  { id: 'surface:4', kind: 'browser', title: 'localhost:6006', browserDisplay: 'iframe' },
];

/** Browser Doors keep the same capability/presentation identity as their pane
 *  header and retain the page label instead of acquiring terminal idle state. */
export const BrowserSurfaces: Story = {
  args: { items: browserSurfaceItems },
  decorators: [
    (Story) => (
      <div style={{ width: 920 }}>
        <Story />
      </div>
    ),
  ],
};

export const OneSpeakingDoor: Story = {
  args: {
    items: oneRingingDoorItems,
  },
  parameters: {
    ...withState(oneRingingDoorItems, {
      'surface:1': { status: 'ALERT_RINGING' },
    }),
    primedAlertSpeech: { 'surface:1': 'speaking' },
  },
};

export const AlarmOutputsEnabled: Story = {
  args: {
    items: [],
  },
  parameters: {
    primedAlertSettings: { speakEnabled: true, pushEnabled: true },
  },
};

export const WorkspaceAlertSettings: Story = {
  args: { items: [] },
  parameters: {
    primedWorkspaces: { workspaces: [{ id: 'workspace:alert-story', name: 'Builds', alertDelivery: { speakEnabled: true } }] },
  },
  decorators: [(Story) => <WorkspaceIdContext.Provider value="workspace:alert-story"><Story /></WorkspaceIdContext.Provider>],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    fireEvent.contextMenu(body.getByRole('button', { name: 'Spoken alarms' }));
    const dialog = body.getByRole('dialog', { name: 'Workspace alert settings' });
    await expect(within(dialog).getByRole('combobox', { name: 'Voice for this workspace' })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use application defaults' }));
    await expect(within(dialog).getByRole('combobox', { name: 'Speech for this workspace' })).toHaveValue('inherit');
    await expect(within(dialog).queryByRole('searchbox')).not.toBeInTheDocument();
  },
};

export const MixedDoorStates: Story = {
  args: {
    items: mixedDoorStateItems,
  },
  parameters: withState(mixedDoorStateItems, {
    'surface:1': {
      status: 'NOTHING_TO_SHOW',

      todo: false,
    },
    'surface:2': {
      status: 'ALERT_RINGING',

      todo: false,
    },
    'surface:3': {
      status: 'WATCHING_DISABLED',

      todo: true,
    },
    'surface:4': {
      status: 'ALERT_RINGING',

      todo: true,
    },
  }),
};

export const OverflowWithRingingDoor: Story = {
  args: {
    items: overflowWithRingingDoorItems,
  },
  parameters: withState(overflowWithRingingDoorItems, {
    'surface:2': {
      status: 'NOTHING_TO_SHOW',

      todo: false,
    },
    'surface:5': {
      status: 'ALERT_RINGING',

      todo: false,
    },
    'surface:7': {
      status: 'WATCHING_DISABLED',

      todo: true,
    },
  }),
  decorators: [
    (Story) => (
      <div style={{ width: 500 }}>
        <Story />
      </div>
    ),
  ],
};

/**
 * Every right-hand element at once — overflow arrow, host notice, and the alarm
 * settings button — in a narrow baseboard. The door-fitting budget subtracts the
 * measured cluster, so doors must stop short of it rather than sliding under it.
 */
export const OverflowWithNoticeAndSettings: Story = {
  args: {
    items: overflowWithRingingDoorItems,
    notice: (
      <span className="flex h-5 items-center rounded bg-surface-raised px-1.5 text-sm font-mono text-muted">
        Update ready
      </span>
    ),
  },
  parameters: withState(overflowWithRingingDoorItems, {
    'surface:5': {
      status: 'ALERT_RINGING',
      todo: false,
    },
  }),
  decorators: [
    (Story) => (
      <div style={{ width: 500 }}>
        <Story />
      </div>
    ),
  ],
};

export const ExtremeTitleWithBothIndicators: Story = {
  args: {
    items: extremeTitleWithBothIndicatorsItems,
  },
  parameters: withState(extremeTitleWithBothIndicatorsItems, {
    'surface:2': {
      status: 'ALERT_RINGING',

      todo: true,
    },
  }),
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
    ),
  ],
};

/**
 * A phone on a one-time connection: "Phone connected · End" joins the measured
 * right cluster, so the Doors fit around it, and End needs no trip to Settings
 * (`docs/specs/one-time.md` -> "Laptop UI"). Its own frame on a docs page: the
 * indicator reads a module store that captures the stub link on its first
 * subscriber, which inline siblings with no Burrow would otherwise share.
 */
export const OneTimePhoneConnected: Story = {
  args: { items: overflowWithRingingDoorItems },
  parameters: {
    ...withState(overflowWithRingingDoorItems, {}),
    primedBurrow: { oneTime: { status: 'connected', label: 'Android phone', since: BASE_TIME } },
    docs: { story: { inline: false, height: '80px' } },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Phone connected');
    await expect(canvas.getByRole('button', { name: 'End the one-time connection' })).toBeVisible();
  },
};

/**
 * Turning an alarm on may add one live line to its preview, once a day
 * (`docs/specs/alert.md` -> "Settings dialog"). Each story turns one on in a
 * build primed by `parameters`.
 */
function alarmUpsellStory(sink: 'speech' | 'push', upsell: AlarmUpsell, parameters: Record<string, unknown>): Story {
  return {
    args: { items: [] },
    parameters: { ...parameters, docs: { story: { inline: false, height: '420px' } } },
    decorators: [
      (Story) => (
        // Room above, as at a window's foot, for the preview that opens upward.
        <div style={{ width: 640, paddingTop: 360 }}>
          <Story />
        </div>
      ),
    ],
    play: async ({ canvasElement }) => {
      await waitForPrimedState();
      // No line before the Burrow service answers the policy.
      await waitFor(() => expect(getNetworkPolicySnapshot().kind).toBe('ready'));
      const body = within(canvasElement.ownerDocument.body);
      await userEvent.click(body.getByRole('button', { name: sink === 'speech' ? 'Spoken alarms' : 'Push notifications' }));
      await waitFor(() => expect(canvasElement.ownerDocument.querySelector(`[data-alarm-upsell="${upsell}"]`)).toBeVisible());
    },
  };
}

const HOSTED_ENROLLED: BurrowConsoleStatus = { ...UNENROLLED_STATUS, enrolled: true, serving: true, burrowId: 'burrow-6f1c2a90', connection: 'connected' };
const UNDER_NOTHING = (status: BurrowConsoleStatus) => ({ status, network: networkPolicyResult(nothingPolicy(), status.relayMode, []) });

/** A Hosted build whose managed voice is not on turns spoken alarms on. */
export const AlarmUpsellTurnOnVoice = alarmUpsellStory('speech', 'voice-turn-on', {
  primedManagedVoice: { configured: false },
  primedBurrow: { status: UNENROLLED_STATUS },
});

/** The same under Nothing, which managed voice cannot reach Hosted through: the line points at the policy. */
export const AlarmUpsellVoiceUnderNothing = alarmUpsellStory('speech', 'voice-network', {
  primedManagedVoice: { configured: false },
  primedBurrow: UNDER_NOTHING(UNENROLLED_STATUS),
});

/** Managed voice is on, and speak said the account has no plan. */
export const AlarmUpsellVoicePlans = alarmUpsellStory('speech', 'voice-plans', {
  primedManagedVoice: { configured: true, notEntitled: true },
  primedBurrow: { status: HOSTED_ENROLLED },
});

/** A Hosted build not enrolled turns push on. */
export const AlarmUpsellHostedRelay = alarmUpsellStory('push', 'push-hosted-relay', {
  primedBurrow: { status: UNENROLLED_STATUS },
});

/** The same under Nothing: the line points at the policy, since no Relay runs under it. */
export const AlarmUpsellPushUnderNothing = alarmUpsellStory('push', 'push-network', {
  primedBurrow: UNDER_NOTHING(UNENROLLED_STATUS),
});

/** The Hosted Relay refuses the account for having no plan; the inert line above says so, and this one links the plans. */
export const AlarmUpsellPushPlans = alarmUpsellStory('push', 'push-plans', {
  primedBurrow: { status: { ...HOSTED_ENROLLED, connection: 'not-entitled' } },
});

/** A build without Hosted mode, not enrolled with its Relay: no word of Hosted. */
export const AlarmUpsellSetUpPhone = alarmUpsellStory('push', 'push-set-up-phone', {
  primedBurrow: { status: SELF_HOST_UNENROLLED_STATUS },
});

/** An enrolled self-host build earns no line: the preview is the plain one. */
export const AlarmUpsellNoneEnrolled: Story = {
  ...alarmUpsellStory('push', 'push-set-up-phone', { primedBurrow: { status: enrolledStatus() } }),
  play: async ({ canvasElement }) => {
    await waitForPrimedState();
    await waitFor(() => expect(getNetworkPolicySnapshot().kind).toBe('ready'));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: 'Push notifications' }));
    await body.findByRole('status');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(canvasElement.ownerDocument.querySelector('[data-alarm-upsell]')).toBeNull();
  },
};

/** Press a story's line; Settings opens scrolled to `topic`. */
function opensTopic(story: Story, topic: 'Notifications' | 'Network'): Story {
  return {
    ...story,
    play: async (context) => {
      await story.play!(context);
      const document = context.canvasElement.ownerDocument;
      await userEvent.click(within(document.querySelector<HTMLElement>('[data-alarm-upsell]')!).getByRole('button'));
      const dialog = within(document.body).getByRole('dialog', { name: 'Settings' });
      const section = within(dialog).getByRole('region', { name: topic });
      const content = section.parentElement!;
      await waitFor(() => expect(Math.abs(section.getBoundingClientRect().top - content.getBoundingClientRect().top - TOPIC_GAP_PX)).toBeLessThan(1), { timeout: 3000 });
    },
  };
}

/** Turning managed voice on happens in Notifications. */
export const AlarmUpsellOpensNotifications = opensTopic(AlarmUpsellTurnOnVoice, 'Notifications');

/** Setting up a phone happens in Network. */
export const AlarmUpsellOpensNetwork = opensTopic(AlarmUpsellSetUpPhone, 'Network');
