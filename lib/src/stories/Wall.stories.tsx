import type { Meta, StoryObj } from '@storybook/react';
import { Wall } from '../components/Wall';
import {
  flattenScenario,
  SCENARIO_SHELL_PROMPT,
  SCENARIO_LS_OUTPUT,
  SCENARIO_ANSI_COLORS,
} from '../lib/platform';
import type { ActivityState } from '../lib/terminal-registry';

const meta: Meta<typeof Wall> = {
  title: 'App/Wall',
  component: Wall,
};

export default meta;
type Story = StoryObj<typeof Wall>;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPrimedActivity(byId: Record<string, Partial<ActivityState>>) {
  return {
    primedSessionState: {
      byId,
    },
  };
}

async function splitPanes() {
  await wait(200);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '"', bubbles: true }));
  await wait(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '%', bubbles: true }));
  await wait(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(100);
}

async function minimizeSelectedPane() {
  await wait(200);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
  await wait(150);
}

async function minimizeFirstVisiblePane() {
  await wait(100);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]');
  button?.click();
  await wait(200);
}

async function openAlertDialog() {
  await wait(250);
  const alertButton = document.querySelector<HTMLButtonElement>('[data-alert-button-for]');
  alertButton?.click();
  await wait(100);
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
  play: splitPanes,
};

export const WithDoors: Story = {
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
  play: async () => {
    await splitPanes();
    await minimizeFirstVisiblePane();
    await minimizeFirstVisiblePane();
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
  play: openAlertDialog,
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
