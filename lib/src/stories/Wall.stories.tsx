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

/** The Wall's visible shape: how many panes are tiled, how many Doors are docked. */
const wallShape = () =>
  `${document.querySelectorAll('[data-pane-header-for]').length}/`
  + `${document.querySelectorAll('[data-door-id]').length}`;

/**
 * Hold until the Wall's shape has stopped changing.
 *
 * Every helper below drives the Wall through the UI a user would, and each step
 * lands asynchronously — a split re-lays out the tree, a minimize moves a pane to
 * the baseboard and the Baseboard then measures its Doors. Sleeping a fixed
 * number of milliseconds and continuing regardless is what makes these snapshots
 * unstable: on a slow runner the next step drives the pre-update DOM, and the
 * story captures a layout it never meant to build.
 *
 * Deliberately a settle, not an assertion on a specific count: these helpers are
 * shared by stories with different starting shapes, and a wrong expectation would
 * fail the build rather than surface a layout regression.
 */
async function settleWallShape() {
  let last = '';
  let stable = 0;
  await waitForCondition(() => {
    const shape = wallShape();
    stable = shape === last ? stable + 1 : 0;
    last = shape;
    return stable >= 2;
  });
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
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '"', bubbles: true }));
  await settleWallShape();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '%', bubbles: true }));
  await settleWallShape();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settleWallShape();
}

async function minimizeSelectedPane() {
  await settleTerminals();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
  await settleWallShape();
}

async function minimizeFirstVisiblePane() {
  const button = await requireElement<HTMLButtonElement>(
    'button[aria-label="Minimize"]',
    'pane Minimize button',
  );
  button.click();
  await settleWallShape();
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
