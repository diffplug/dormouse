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
  onStartRename: () => {},
  onFinishRename: () => {},
  onCancelRename: () => {},
};

function primedState(state: Record<string, unknown>) {
  return {
    primedSessionState: {
      byId: {
        [SESSION_ID]: state,
      },
    },
  };
}

function TabStory({
  title = 'my-terminal',
  mode = 'command' as WallMode,
  isSelected = true,
  isRenaming = false,
  width = 360,
  reducedMotion = false,
}: {
  title?: string;
  mode?: WallMode;
  isSelected?: boolean;
  isRenaming?: boolean;
  width?: number;
  reducedMotion?: boolean;
}) {
  const mockApi = { id: SESSION_ID, title } as any;

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={isSelected ? SESSION_ID : null}>
        <WallActionsContext.Provider value={noopActions}>
          <RenamingIdContext.Provider value={isRenaming ? SESSION_ID : null}>
            <div
              className={reducedMotion ? '[&_button]:!animate-none [&_*]:!transition-none' : undefined}
              style={{ width }}
            >
              <div className="bg-app-bg" style={{ height: 26 }}>
                <TerminalPaneHeader api={mockApi} containerApi={{} as any} params={{}} tabLocation={'header' as any} />
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
  },
  args: {
    title: 'build-server',
    mode: 'command',
    isSelected: true,
    isRenaming: false,
    width: 360,
    reducedMotion: false,
  },
};

export default meta;
type Story = StoryObj<typeof TabStory>;

export const AlertDisabled: Story = {
  parameters: primedState({
    status: 'ALERT_DISABLED',

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
    status: 'ALERT_DISABLED',
    todo: true,
  }),
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
