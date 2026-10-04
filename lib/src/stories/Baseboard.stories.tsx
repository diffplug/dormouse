import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fireEvent, userEvent, within } from 'storybook/test';
import { Baseboard } from '../components/Baseboard';
import { WorkspaceIdContext } from '../components/wall/wall-context';
import type { DoorChip } from '../components/Wall';
import { createTerminalPaneState, type TerminalPaneState } from '../lib/terminal-state';
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

const oneRingingDoorItems = [makeItem('p1', 'build-server')];
const mixedDoorStateItems = [
  makeItem('p1', 'dev-server'),
  makeItem('p2', 'test-runner'),
  makeItem('p3', 'logs'),
  makeItem('p4', 'notarization'),
];
const overflowWithRingingDoorItems = [
  makeItem('p1', 'frontend-dev'),
  makeItem('p2', 'backend-api'),
  makeItem('p3', 'database-migrations'),
  makeItem('p4', 'test-runner'),
  makeItem('p5', 'log-aggregator'),
  makeItem('p6', 'build-pipeline'),
  makeItem('p7', 'monitoring'),
  makeItem('p8', 'linter'),
];
const extremeTitleWithBothIndicatorsItems = [
  makeItem('p1', 'short'),
  makeItem('p2', 'my-extremely-long-running-background-process-with-a-very-descriptive-name'),
  makeItem('p3', 'another'),
];
const browserSurfaceItems: DoorChip[] = [
  { id: 'browser-resize', kind: 'browser', title: 'localhost:5173/app', browserDisplay: 'agent-browser-resize' },
  { id: 'browser-fixed', kind: 'browser', title: 'mobile checkout', browserDisplay: 'agent-browser-fixed' },
  { id: 'browser-popout', kind: 'browser', title: 'docs.example.com', browserDisplay: 'agent-browser-popout' },
  { id: 'browser-iframe', kind: 'browser', title: 'localhost:6006', browserDisplay: 'iframe' },
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
      p1: { status: 'ALERT_RINGING' },
    }),
    primedAlertSpeech: { p1: 'speaking' },
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
    primedWorkspaces: { workspaces: [{ id: 'workspace-alert-story', name: 'Builds', alertDelivery: { speakEnabled: true } }] },
  },
  decorators: [(Story) => <WorkspaceIdContext.Provider value="workspace-alert-story"><Story /></WorkspaceIdContext.Provider>],
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
    p1: {
      status: 'NOTHING_TO_SHOW',

      todo: false,
    },
    p2: {
      status: 'ALERT_RINGING',

      todo: false,
    },
    p3: {
      status: 'WATCHING_DISABLED',

      todo: true,
    },
    p4: {
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
    p2: {
      status: 'NOTHING_TO_SHOW',

      todo: false,
    },
    p5: {
      status: 'ALERT_RINGING',

      todo: false,
    },
    p7: {
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
    p5: {
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
    p2: {
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
 * Turning an alarm on can add one live line to the toggle's preview
 * (`docs/specs/alert.md` -> "Settings dialog"). Each story turns one on.
 */
function alarmUpsellStory(sink: 'speech' | 'push', upsell: string, parameters: Record<string, unknown>): Story {
  return {
    args: { items: [] },
    parameters: { ...parameters, docs: { story: { inline: false, height: '260px' } } },
    decorators: [
      (Story) => (
        // At the bottom, as in a window, so the preview opens above.
        <div style={{ width: 640, marginTop: 'auto' }}>
          <Story />
        </div>
      ),
    ],
    play: async ({ canvasElement }) => {
      await waitForPrimedState();
      const body = within(canvasElement.ownerDocument.body);
      await userEvent.click(body.getByRole('button', { name: sink === 'speech' ? 'Spoken alarms' : 'Push notifications' }));
      const line = canvasElement.ownerDocument.querySelector(`[data-alarm-upsell="${upsell}"]`);
      await expect(line).toBeVisible();
    },
  };
}

/** A Hosted build's non-member turns spoken alarms on. */
export const AlarmUpsellHostedVoice = alarmUpsellStory('speech', 'hosted-voice', {
  primedManagedVoice: { configured: false },
});

/** A Hosted build's non-member, not enrolled with a Relay, turns push on. */
export const AlarmUpsellHostedPush = alarmUpsellStory('push', 'hosted-push', {
  primedManagedVoice: { configured: false },
  primedBurrow: {},
  primedPushDevices: { status: 'no-burrow', devices: [] },
});

/** A build with no Hosted mode, or a member, with no phone to push to. */
export const AlarmUpsellSetUpPhone = alarmUpsellStory('push', 'set-up-phone', {
  primedBurrow: {},
  primedPushDevices: { status: 'no-burrow', devices: [] },
});
