import type { Meta, StoryObj } from '@storybook/react';
import { Wall } from '../components/Wall';
import {
  flattenScenario,
  SCENARIO_SHELL_PROMPT,
  SCENARIO_LS_OUTPUT,
  SCENARIO_ANSI_COLORS,
} from '../lib/platform';
import type { ActivityState } from '../lib/terminal-registry';
import { requireElement, settleTerminals, waitForCondition } from './settle-terminals';

const meta: Meta<typeof Wall> = {
  title: 'App/Wall',
  component: Wall,
  // Hold every snapshot until the terminals have written their scenario and painted.
  // Stories that define their own `play` override this and call `settleTerminals()`
  // themselves at the end.
  play: () => settleTerminals(),
};

export default meta;
type Story = StoryObj<typeof Wall>;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const paneCount = () => document.querySelectorAll('[data-pane-header-for]').length;
const doorCount = () => document.querySelectorAll('[data-door-id]').length;

/**
 * Wait for a count to reach `want`, and throw if it never does.
 *
 * Every helper below drives the Wall through the UI a user would, and each step
 * lands asynchronously — a split re-lays out the tree, a minimize moves a pane to
 * the baseboard and the Baseboard then measures its Doors. Sleeping a fixed
 * number of milliseconds and continuing regardless is what made these snapshots
 * unstable: on a slow runner the next step drives the pre-update DOM, and the
 * story captures a layout it never meant to build. Counts are relative to what
 * was on screen when the step started, so the same helper serves stories that
 * begin with different shapes.
 */
async function expectCount(count: () => number, want: number, what: string) {
  await waitForCondition(() => count() === want);
  if (count() !== want) throw new Error(`expected ${want} ${what}, saw ${count()}`);
}

/**
 * Return to command mode with the leader chord — left Shift then right Shift
 * within 500ms (`keyboard/handle-dual-tap.ts`).
 *
 * Required between splits: a split is an intent to use the new terminal, so
 * `addSplitPanel` enters passthrough, and the wall ignores pane shortcuts there.
 * Without the chord the second split key is typed into the terminal instead, and
 * the story quietly builds one pane fewer than it means to.
 */
function enterCommandMode() {
  for (const location of [1, 2]) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location, bubbles: true }));
  }
}

function withPrimedActivity(byId: Record<string, Partial<ActivityState>>) {
  return {
    primedSessionState: {
      byId,
    },
  };
}

async function splitPanes() {
  // The Wall must be live before it can act on a keystroke; settling its terminals
  // is the readiness signal (it also covers the primed-state gate).
  await settleTerminals();
  const panesBefore = paneCount();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '"', bubbles: true }));
  await expectCount(paneCount, panesBefore + 1, 'panes after the vertical split');
  enterCommandMode();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '%', bubbles: true }));
  await expectCount(paneCount, panesBefore + 2, 'panes after the horizontal split');
  // No trailing Enter: the second split already left the wall in passthrough on
  // the pane it created, which is the resting state these stories capture.
}

async function minimizeSelectedPane() {
  await settleTerminals();
  const doorsBefore = doorCount();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
  await expectCount(doorCount, doorsBefore + 1, 'doors after minimizing');
}

async function minimizeFirstVisiblePane() {
  const doorsBefore = doorCount();
  const button = await requireElement<HTMLButtonElement>(
    'button[aria-label="Minimize"]',
    'pane Minimize button',
  );
  button.click();
  await expectCount(doorCount, doorsBefore + 1, 'doors after minimizing');
}

async function openAlertDialog() {
  const alertButton = await requireElement<HTMLButtonElement>('[data-alert-button-for]', 'alert bell');
  alertButton.click();
  await requireElement('[role="dialog"]', 'TODO and alert dialog');
}

export const Default: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
};

export const WithLsOutput: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
};

export const WithAnsiColors: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_ANSI_COLORS) } },
};

export const MultiPane: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
  play: async () => {
    await splitPanes();
    await settleTerminals();
  },
};

export const WithDoors: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
  play: async () => {
    await splitPanes();
    await minimizeFirstVisiblePane();
    await minimizeFirstVisiblePane();
    await settleTerminals();
  },
};

export const AlertEnabledIdlePane: Story = {
  args: {
    initialPaneIds: ['wall-alert-enabled'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-alert-enabled': {
        status: 'NOTHING_TO_SHOW',
        todo: false,
      },
    }),
  },
};

export const AlertRingingPane: Story = {
  args: {
    initialPaneIds: ['wall-alert-ringing'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-alert-ringing': {
        status: 'ALERT_RINGING',
        todo: false,
      },
    }),
  },
};

export const AlertRingingDoor: Story = {
  args: {
    initialPaneIds: ['wall-alert-ringing-door'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-alert-ringing-door': {
        status: 'ALERT_RINGING',
        todo: false,
      },
    }),
  },
  play: async () => {
    await minimizeSelectedPane();
    await wait(100);
    await settleTerminals();
  },
};

export const AlertModalOpen: Story = {
  args: {
    initialPaneIds: ['wall-alert-modal'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-alert-modal': {
        status: 'ALERT_RINGING',
        todo: false,
      },
    }),
  },
  play: async () => {
    // Settle first: the bell only offers the dialog once the primed ALERT_RINGING
    // status has landed, so clicking it earlier is a no-op and the story
    // snapshots a wall with no dialog.
    await settleTerminals();
    await openAlertDialog();
  },
};

export const TodoAfterDismiss: Story = {
  args: {
    initialPaneIds: ['wall-todo-after-dismiss'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-todo-after-dismiss': {
        status: 'ALERT_RINGING',
        todo: true,
      },
    }),
  },
};

export const MinimizedRingingSession: Story = {
  args: {
    initialPaneIds: ['wall-minimized-ringing'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-minimized-ringing': {
        status: 'ALERT_RINGING',
        todo: true,
      },
    }),
  },
  play: async () => {
    await minimizeSelectedPane();
    await wait(100);
    await settleTerminals();
  },
};

export const MultipleRingingSessions: Story = {
  args: {
    initialPaneIds: ['wall-ringing-one', 'wall-ringing-todo', 'wall-alert-enabled-idle'],
  },
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    ...withPrimedActivity({
      'wall-ringing-one': {
        status: 'ALERT_RINGING',
        todo: false,
      },
      'wall-ringing-todo': {
        status: 'ALERT_RINGING',
        todo: true,
      },
      'wall-alert-enabled-idle': {
        status: 'NOTHING_TO_SHOW',
        todo: false,
      },
    }),
  },
};
