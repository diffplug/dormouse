import type { Meta, StoryObj } from '@storybook/react';
import { TodoAlertDialog } from '../components/TodoAlertDialog';
import type { ActivityNotification } from '../lib/alert-manager';
import { summarizeCommandLine } from '../lib/terminal-registry';

const SESSION_ID = 'dialog-story';

/**
 * The dialog is normally anchored to a pane header's bell. Rendering it directly
 * against a fixed rect keeps these stories about the dialog's own content — the
 * WATCHING rule switch, the no-command explanation, and the rule list — rather
 * than about the header that opens it. `TerminalPaneHeader.stories.tsx` covers
 * the header-driven path.
 */
function DialogStory() {
  return (
    <div style={{ height: 420 }}>
      <TodoAlertDialog
        triggerRect={new DOMRect(24, 16, 20, 20)}
        sessionId={SESSION_ID}
        onClose={() => {}}
        onKeyboardActiveChange={() => {}}
      />
    </div>
  );
}

/**
 * Report a foreground command the way shell integration would, so the dialog can
 * resolve the argv0 its rule switch acts on (`docs/specs/alert.md`). `startedAt`
 * is fixed rather than `Date.now()` to keep Chromatic snapshots deterministic.
 */
function running(rawCommandLine: string) {
  return {
    primedTerminalState: {
      byId: {
        [SESSION_ID]: {
          activity: { kind: 'running' as const },
          currentCommand: {
            id: 'story-run',
            rawCommandLine,
            displayCommand: summarizeCommandLine(rawCommandLine),
            cwdAtStart: null,
            startedAt: 0,
            source: 'osc633_E' as const,
          },
        },
      },
    },
  };
}

function activity(state: Record<string, unknown>) {
  return { primedSessionState: { byId: { [SESSION_ID]: state } } };
}

const IDLE = { status: 'WATCHING_DISABLED', todo: false };
const WATCHING = { status: 'NOTHING_TO_SHOW', todo: false, watchingEnabled: true };

const NOTIFICATION: ActivityNotification = {
  source: 'OSC 777',
  title: 'Tests complete',
  body: '341 passed, 0 failed',
};

const meta: Meta<typeof DialogStory> = {
  title: 'Components/TodoAlertDialog',
  component: DialogStory,
};

export default meta;
type Story = StoryObj<typeof DialogStory>;

/**
 * The common case: a watched command is running, so the switch names it and the
 * rule shows up in the list below.
 */
export const RuleOn: Story = {
  parameters: {
    ...running('claude --resume'),
    ...activity(WATCHING),
    primedWatchedCommands: ['claude'],
  },
};

/** Same pane, no rule yet — the switch offers to create one. */
export const RuleOff: Story = {
  parameters: {
    ...running('claude --resume'),
    ...activity(IDLE),
    primedWatchedCommands: [],
  },
};

/**
 * The state the bell opens when there is nothing to key a rule on. This is the
 * only way to reach the dialog from a pane sitting at a prompt, so it carries
 * the explanation of why the switch is missing.
 */
export const NoCommandRunning: Story = {
  parameters: {
    ...activity(IDLE),
    primedWatchedCommands: [],
  },
};

/**
 * Nothing running *and* rules already set. The list is the only place a rule
 * created on a since-closed pane can be found and removed, so it has to render
 * even when the switch above it cannot.
 */
export const NoCommandWithExistingRules: Story = {
  parameters: {
    ...activity(IDLE),
    primedWatchedCommands: ['claude', 'pnpm'],
  },
};

/** A realistic accumulated rule set — checks list rhythm and alignment. */
export const ManyRules: Story = {
  parameters: {
    ...running('pnpm test --watch'),
    ...activity(WATCHING),
    primedWatchedCommands: ['cargo', 'claude', 'docker', 'pnpm', 'pytest', 'tsc'],
  },
};

/** Every region at once: TODO on, rule on, notification detail, rule list. */
export const RuleWithNotification: Story = {
  parameters: {
    ...running('pnpm test'),
    ...activity({ status: 'ALERT_RINGING', todo: true, watchingEnabled: true, notification: NOTIFICATION }),
    primedWatchedCommands: ['pnpm', 'claude'],
  },
};

/**
 * A ring with no rule behind it — a program that asked for attention itself.
 * The switch still offers a rule for whatever is running.
 */
export const NotificationWithoutRule: Story = {
  parameters: {
    ...running('make build'),
    ...activity({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'BEL', title: 'Terminal bell', body: null } satisfies ActivityNotification,
    }),
    primedWatchedCommands: [],
  },
};

/**
 * argv0 is a basename, so it is normally short — but nothing enforces that.
 * A pathological name must wrap or truncate instead of widening the dialog.
 */
export const LongCommandName: Story = {
  parameters: {
    ...running('./scripts/really-long-generated-integration-test-runner-name.sh --all'),
    ...activity(WATCHING),
    primedWatchedCommands: [
      './scripts/really-long-generated-integration-test-runner-name.sh'.split('/').pop()!,
      'claude',
    ],
  },
};
