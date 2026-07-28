import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  TerminalPaneHeader,
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  RenamingIdContext,
  type WallMode,
  type WallActions,
} from '../components/Wall';
import type { ActivityNotification } from '../lib/alert-manager';
import type { SetTerminalUserTitleResult } from '../lib/terminal-registry';
import { removeMouseSelectionState, setMouseReporting, setOverride } from '../lib/mouse-selection';

const SESSION_ID = 'tab-story';

const noopActions: WallActions = {
  onKill: () => {},
  onMinimize: () => {},
  onAlertButton: () => 'noop',
  onToggleTodo: () => {},
  onSplitH: () => {},
  onSplitV: () => {},
  onZoom: () => {},
  onClickPanel: () => {},
  onFocusPane: () => {},
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: () => {},
  resolveSurfaceRef: (id) => id,
  onConnectPort: () => {},
};

function actionsRejecting(reason: 'empty' | 'reserved'): WallActions {
  const rejection: SetTerminalUserTitleResult = { accepted: false, reason };
  return { ...noopActions, onFinishRename: () => rejection };
}

function primedState(state: Record<string, unknown>) {
  return {
    primedSessionState: {
      byId: {
        [SESSION_ID]: state,
      },
    },
  };
}

function primedNotificationState(notification: ActivityNotification, status = 'WATCHING_DISABLED') {
  return primedState({
    status,
    todo: true,
    notification,
  });
}

function TabStory({
  title = 'my-terminal',
  mode = 'command' as WallMode,
  isSelected = true,
  isRenaming = false,
  width = 360,
  reducedMotion = false,
  mouseCaptured = false,
  actions = noopActions,
}: {
  title?: string;
  mode?: WallMode;
  isSelected?: boolean;
  isRenaming?: boolean;
  width?: number;
  reducedMotion?: boolean;
  /** Simulate a TUI capturing the mouse, which surfaces the mouse-override icon. */
  mouseCaptured?: boolean;
  actions?: WallActions;
}) {
  useEffect(() => {
    if (!mouseCaptured) return;
    setMouseReporting(SESSION_ID, 'any');
    setOverride(SESSION_ID, 'temporary');
    return () => removeMouseSelectionState(SESSION_ID);
  }, [mouseCaptured]);

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={isSelected ? SESSION_ID : null}>
        <WallActionsContext.Provider value={actions}>
          <RenamingIdContext.Provider value={isRenaming ? SESSION_ID : null}>
            <div
              className={reducedMotion ? '[&_button]:!animate-none [&_*]:!transition-none' : undefined}
              style={{ width }}
            >
              <div className="bg-app-bg" style={{ height: 26 }}>
                <TerminalPaneHeader id={SESSION_ID} title={title} params={undefined} />
              </div>
            </div>
          </RenamingIdContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openAlertRightClickDialog() {
  await wait(100);
  const alertButton = document.querySelector<HTMLButtonElement>(`[data-alert-button-for="${SESSION_ID}"]`);
  if (!alertButton) return;

  const rect = alertButton.getBoundingClientRect();
  alertButton.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
  await wait(100);
}

async function openTodoNotificationPreview() {
  await wait(100);
  const todoButton = document.querySelector<HTMLButtonElement>(`[data-session-todo-for="${SESSION_ID}"]`);
  todoButton?.focus();
  await wait(100);
}

async function submitReservedRename() {
  await wait(100);
  const input = document.querySelector<HTMLInputElement>(
    `[data-renaming-input-for="${SESSION_ID}"]`,
  ) ?? document.querySelector<HTMLInputElement>('input');
  if (!input) return;
  input.value = '<idle>';
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
  await wait(50);
}

/**
 * Confirms the minimize + close controls are the top-priority elements of the
 * header: they must render and stay fully inside the header bounds (never
 * clipped or pushed out) no matter how narrow it gets. Throws — so the failure
 * surfaces in Storybook's Interactions panel — if either control is missing,
 * collapsed to zero size, or sticking outside the header's horizontal extent.
 */
async function assertControlsVisible({ canvasElement }: { canvasElement: HTMLElement }) {
  const CONTROLS = [
    ['Minimize', '[aria-label="Minimize"]'],
    ['Kill', '[aria-label="Kill"]'],
  ] as const;
  const EPS = 0.5;

  // Returns a human-readable reason the controls aren't fully visible yet, or
  // null once every control is rendered and sits inside the header bounds.
  const violation = (): string | null => {
    const header = canvasElement.querySelector<HTMLElement>('.bg-app-bg');
    if (!header) return 'header container not found';
    const bounds = header.getBoundingClientRect();
    for (const [name, selector] of CONTROLS) {
      const el = canvasElement.querySelector<HTMLElement>(selector);
      if (!el) return `${name} button is not rendered`;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return `${name} button collapsed to zero size (hidden)`;
      if (r.left < bounds.left - EPS || r.right > bounds.right + EPS) {
        return `${name} button is clipped: button x=[${r.left.toFixed(1)}, ${r.right.toFixed(1)}] `
          + `exceeds header x=[${bounds.left.toFixed(1)}, ${bounds.right.toFixed(1)}]`;
      }
    }
    return null;
  };

  // Poll until the primed state (two rAFs) and the ResizeObserver-driven tier
  // have settled, instead of guessing a fixed delay. Surface the last reason if
  // it never settles within the timeout.
  const start = performance.now();
  let reason = violation();
  while (reason && performance.now() - start < 1000) {
    await wait(16);
    reason = violation();
  }
  if (reason) throw new Error(reason);
}

const NOTIFICATIONS = {
  osc9BodyOnly: {
    source: 'OSC 9',
    title: null,
    body: 'Build finished successfully.',
  },
  osc777TitleAndBody: {
    source: 'OSC 777',
    title: 'Tests complete',
    body: '341 passed, 0 failed',
  },
  osc99TitleOnly: {
    source: 'OSC 99',
    title: 'Claude is waiting',
    body: null,
  },
  progressComplete: {
    source: 'OSC 9;4',
    title: 'Progress complete',
    body: 'Progress 100%',
  },
  terminalBell: {
    source: 'BEL',
    title: 'Terminal bell',
    body: null,
  },
  longBody: {
    source: 'OSC 99',
    title: 'Long notification text should wrap without pushing controls out of the header',
    body: 'This body is intentionally long so the TODO dialog has to wrap text and constrain the scroll area. It represents agent output with several clauses, paths, and status details that should remain readable without replacing the visible TODO pill text or changing the pane header layout.',
  },
} satisfies Record<string, ActivityNotification>;

const meta: Meta<typeof TabStory> = {
  title: 'Components/TerminalPaneHeader',
  component: TabStory,
  argTypes: {
    mode: { control: 'radio', options: ['command', 'passthrough'] },
    isSelected: { control: 'boolean' },
    isRenaming: { control: 'boolean' },
    title: { control: 'text' },
    width: { control: 'number' },
    reducedMotion: { control: 'boolean' },
    mouseCaptured: { control: 'boolean' },
  },
  args: {
    title: 'build-server',
    mode: 'command',
    isSelected: true,
    isRenaming: false,
    width: 360,
    reducedMotion: false,
    mouseCaptured: false,
  },
};

export default meta;
type Story = StoryObj<typeof TabStory>;

export const AlertDisabled: Story = {
  parameters: primedState({
    status: 'WATCHING_DISABLED',

    todo: false,
  }),
};

export const AlertEnabled: Story = {
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',

    todo: false,
  }),
};

export const AlertMightBeBusy: Story = {
  parameters: primedState({
    status: 'MIGHT_BE_BUSY',

    todo: false,
  }),
};

export const AlertBusy: Story = {
  parameters: primedState({
    status: 'BUSY',

    todo: false,
  }),
};

export const AlertMightNeedAttention: Story = {
  parameters: primedState({
    status: 'MIGHT_NEED_ATTENTION',

    todo: false,
  }),
};

export const AlertRinging: Story = {
  parameters: primedState({
    status: 'ALERT_RINGING',

    todo: false,
  }),
};

export const AlertRightClickDialog: Story = {
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',
    todo: false,
  }),
  play: openAlertRightClickDialog,
};

export const TodoOnly: Story = {
  parameters: primedState({
    status: 'WATCHING_DISABLED',
    todo: true,
  }),
};

export const TodoWithNotificationPreview: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.osc777TitleAndBody),
  play: openTodoNotificationPreview,
};

export const TodoWithLongNotificationPreview: Story = {
  args: {
    width: 320,
  },
  parameters: primedNotificationState(NOTIFICATIONS.longBody),
  play: openTodoNotificationPreview,
};

export const NotificationDialogTitleAndBody: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.osc777TitleAndBody, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const NotificationDialogBodyOnly: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.osc9BodyOnly, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const NotificationDialogTitleOnly: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.osc99TitleOnly, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const NotificationDialogProgressComplete: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.progressComplete, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const NotificationDialogTerminalBell: Story = {
  parameters: primedNotificationState(NOTIFICATIONS.terminalBell, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const NotificationDialogLongBody: Story = {
  args: {
    width: 320,
  },
  parameters: primedNotificationState(NOTIFICATIONS.longBody, 'ALERT_RINGING'),
  play: openAlertRightClickDialog,
};

export const TodoAndAlertEnabled: Story = {
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',

    todo: true,
  }),
};

export const TodoAndAlertRinging: Story = {
  parameters: primedState({
    status: 'ALERT_RINGING',

    todo: true,
  }),
};

export const CompactWidthWithAlert: Story = {
  args: {
    width: 220,
  },
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',

    todo: false,
  }),
};

export const MinimalWidthWithAlert: Story = {
  args: {
    width: 150,
  },
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',

    todo: false,
  }),
};

export const LongTitleWithAlertAndTodo: Story = {
  args: {
    title: 'my-extremely-long-running-background-process-with-a-very-descriptive-name',
    width: 360,
  },
  parameters: primedState({
    status: 'ALERT_RINGING',

    todo: true,
  }),
};

export const ReducedMotionRinging: Story = {
  args: {
    reducedMotion: true,
  },
  parameters: primedState({
    status: 'ALERT_RINGING',

    todo: false,
  }),
};

export const RenameRejectedReserved: Story = {
  args: {
    title: 'build-server',
    isRenaming: true,
    actions: actionsRejecting('reserved'),
  },
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',
    todo: false,
  }),
  play: submitReservedRename,
};

// --- Minimize + close stay visible as the header shrinks -------------------
//
// These stories drive the header down to (and below) the `minimal` tier and
// assert in their play function that the minimize and close controls remain
// rendered and fully inside the header bounds. The assertion uses live layout
// geometry, so it confirms the controls in the real Storybook browser.

export const NarrowControlsVisible: Story = {
  args: {
    width: 110,
  },
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',
    todo: false,
  }),
  play: assertControlsVisible,
};

export const ExtremelyNarrowControlsVisible: Story = {
  args: {
    width: 76,
  },
  parameters: primedState({
    status: 'ALERT_RINGING',
    todo: true,
  }),
  play: assertControlsVisible,
};

export const NarrowWithMouseCaptureControlsVisible: Story = {
  args: {
    width: 120,
    mouseCaptured: true,
  },
  parameters: primedState({
    status: 'NOTHING_TO_SHOW',
    todo: false,
  }),
  play: assertControlsVisible,
};

export const NarrowLongTitleControlsVisible: Story = {
  args: {
    title: 'my-extremely-long-running-background-process-with-a-very-descriptive-name',
    width: 130,
  },
  parameters: primedState({
    status: 'ALERT_RINGING',
    todo: true,
  }),
  play: assertControlsVisible,
};
