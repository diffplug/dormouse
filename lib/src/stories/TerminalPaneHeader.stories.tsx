import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  TerminalPaneHeader,
  Wall,
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  RenamingIdContext,
  type WallMode,
  type WallActions,
} from '../components/Wall';
import type { ActivityNotification, SessionStatus } from '../lib/alert-manager';
import { summarizeCommandLine, type SetTerminalUserTitleResult } from '../lib/terminal-registry';
import { commandArgv0, cwdFromOsc633 } from '../lib/terminal-state';
import { flattenScenario, SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { removeMouseSelectionState, setMouseReporting, setOverride } from '../lib/mouse-selection';
import { addPlainNote, clearAllNotepads } from '../lib/notepad/notepad-store';
import { recordToolDirty, resetToolDirty } from '../lib/tool-dirty-store';
import { requireElement, settleTerminalContext, waitForCondition, waitForPrimedState } from './settle-terminals';

const SESSION_ID = 'tab-story';

const noopActions: WallActions = {
  onKill: () => {},
  onMinimize: () => {},
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
  onResolveToolApproval: () => {},
};

function actionsRejecting(reason: 'empty' | 'reserved'): WallActions {
  const rejection: SetTerminalUserTitleResult = { accepted: false, reason };
  return { ...noopActions, onFinishRename: () => rejection };
}

const LONG_TITLE = 'my-extremely-long-running-background-process-with-a-very-descriptive-name';
// Where the fake helper terminal opens, so the context finds the two directories
// comparable instead of warning that one never reported.
const PANE_CWD = cwdFromOsc633('/home/demo/projects/dormouse', 0);

// Whether a status is public only while WATCHING is on — the detector states
// (`docs/specs/alert.md` -> Public State). Exhaustive, so a new status must
// decide here.
const SHOWN_ONLY_WHILE_WATCHING: Readonly<Record<SessionStatus, boolean>> = {
  NOTHING_TO_SHOW: true,
  MIGHT_BE_BUSY: true,
  BUSY: true,
  MIGHT_NEED_ATTENTION: true,
  WATCHING_DISABLED: false,
  ALERT_RINGING: false,
  OSC_NOTIF_BUSY: false,
  COMMAND_EXIT_ARMED: false,
};

interface PanePriming {
  status: SessionStatus;
  todo?: boolean;
  notification?: ActivityNotification;
  /**
   * The foreground command, reported the way shell integration would; `null` is
   * a pane at its prompt. WATCHING is keyed on its name, so without one there is
   * no rule to name and every dialog renders its "nothing is running" variant.
   */
  command?: string | null;
  /**
   * The title a rename pins; `null` lets the header derive one. The header's
   * `title` prop is only the fallback for a bare `shell` label, so an unprimed
   * pane reads `<idle>` whatever that prop says.
   */
  userTitle?: string | null;
}

/**
 * Prime one pane's Activity and semantic state as a coherent pair: a detector
 * status comes with a running command and a WATCHING rule for it. Timestamps are
 * fixed rather than `Date.now()` for deterministic Chromatic snapshots.
 */
function primedPane({ status, todo = false, notification, command = 'pnpm dev', userTitle = 'build-server' }: PanePriming) {
  const watching = SHOWN_ONLY_WHILE_WATCHING[status];
  const argv0 = command ? commandArgv0(command) : null;
  if (watching && !argv0) throw new Error(`${status} is public only while a watched command runs`);
  return {
    primedSessionState: {
      byId: {
        [SESSION_ID]: { status, todo, watchingEnabled: watching, ...(notification ? { notification } : {}) },
      },
    },
    primedTerminalState: {
      byId: {
        [SESSION_ID]: {
          cwd: PANE_CWD,
          ...(userTitle ? { title: { title: userTitle, source: 'user' as const, updatedAt: 0 } } : {}),
          ...(command ? {
            activity: { kind: 'running' as const },
            currentCommand: {
              id: 'story-run',
              rawCommandLine: command,
              displayCommand: summarizeCommandLine(command),
              cwdAtStart: PANE_CWD,
              startedAt: 0,
              source: 'osc633_E' as const,
            },
          } : {}),
        },
      },
    },
    primedWatchedCommands: watching && argv0 ? [argv0] : [],
  };
}

function TabStory({
  mode = 'command' as WallMode,
  isSelected = true,
  isRenaming = false,
  width = 360,
  reducedMotion = false,
  mouseCaptured = false,
  noteCount = 0,
  dirty = false,
  actions = noopActions,
}: {
  mode?: WallMode;
  isSelected?: boolean;
  isRenaming?: boolean;
  width?: number;
  reducedMotion?: boolean;
  /** Simulate a TUI capturing the mouse, which surfaces the mouse-override icon. */
  mouseCaptured?: boolean;
  /** Notes on this Surface — the notepad icon fills, and survives the minimal tier. */
  noteCount?: number;
  /** A Tool terminal face reporting unsaved changes — the dot takes its own
   *  12px at the header root, outside the region that clips. */
  dirty?: boolean;
  actions?: WallActions;
}) {
  useEffect(() => {
    if (!mouseCaptured) return;
    setMouseReporting(SESSION_ID, 'any');
    setOverride(SESSION_ID, 'temporary');
    return () => removeMouseSelectionState(SESSION_ID);
  }, [mouseCaptured]);

  useEffect(() => {
    for (let i = 0; i < noteCount; i++) addPlainNote(SESSION_ID, `note ${i + 1}`);
    return () => clearAllNotepads();
  }, [noteCount]);

  useEffect(() => {
    if (!dirty) return;
    recordToolDirty(SESSION_ID, true);
    return () => resetToolDirty();
  }, [dirty]);

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
                <TerminalPaneHeader id={SESSION_ID} title={undefined} params={dirty ? { surfaceType: 'tool' } : undefined} />
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

/** How long a play function keeps re-driving an interaction before giving up.
 *  Matches `waitForCondition`'s default so every gate in a story shares one
 *  patience budget. */
const RETRY_BUDGET_MS = 4000;

/**
 * Context interactions need the full Wall, which owns the unified menu. The
 * frame is a flex column because the Wall's root is `flex-1`: in a block frame
 * it collapses to the Baseboard's height, and the pane and dialog render but
 * are never seen.
 */
function ContextWallStory() {
  return <div className="flex flex-col" style={{ width: 900, height: 680 }}><Wall initialPaneIds={[SESSION_ID]} initialMode="command" /></div>;
}

/** Open the terminal context from the header of a Wall whose one pane is `pane`. */
function contextDialogStory(pane: PanePriming): Story {
  return {
    render: ContextWallStory,
    parameters: {
      // The derived title is part of what the context's Title row explains.
      ...primedPane({ userTitle: null, ...pane }),
      // Output for the pane's terminal, which `settleTerminals` waits on.
      fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) },
    },
    play: openHeaderRightClickDialog,
  };
}

/** Wait for priming before opening the source's alert controls in context. */
async function openHeaderRightClickDialog() {
  await waitForPrimedState();
  const header = await requireElement<HTMLElement>(
    `[data-pane-header-for="${SESSION_ID}"]`,
    'pane header',
  );

  const rect = header.getBoundingClientRect();
  header.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
  await settleTerminalContext();
}

/**
 * Open the TODO pill's notification preview.
 *
 * The pill opens it on both focus and hover, and this drives both: a programmatic
 * `.focus()` is a no-op while the document itself is unfocused, and `mouseover`
 * is exactly what React synthesizes `onMouseEnter` from — neither adds a visual
 * state of its own (the pill's hover tint is CSS `:hover`, which a synthetic
 * event never sets). Retried, and throws if the preview never appears, for the
 * same reason as `openHeaderRightClickDialog`: silently snapshotting a header
 * with no preview is the failure this story exists to catch.
 */
async function openTodoNotificationPreview() {
  await waitForPrimedState();
  const pill = await requireElement<HTMLButtonElement>(
    `[data-session-todo-for="${SESSION_ID}"]`,
    'TODO pill',
  );
  const start = performance.now();
  while (performance.now() - start < RETRY_BUDGET_MS) {
    pill.focus();
    const rect = pill.getBoundingClientRect();
    pill.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      cancelable: true,
      relatedTarget: document.body,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    await wait(50);
    if (document.querySelector(`#todo-notification-preview-${SESSION_ID}`)) return;
  }
  throw new Error('TODO notification preview never rendered');
}

async function submitReservedRename() {
  await waitForPrimedState();
  const input = await requireElement<HTMLInputElement>(
    `[data-renaming-input-for="${SESSION_ID}"]`,
    'rename input',
  );
  input.value = '<idle>';
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
  await requireElement('[data-testid="illegal-rename-warning"]', 'illegal-rename warning');
}

const PANE_ACTIONS = ['Zoom', 'Minimize', 'Kill'] as const;
type PaneAction = typeof PANE_ACTIONS[number];

/**
 * Confirms the pane-action group is the top-priority element of the header:
 * whatever a width still affords must render and stay fully inside the header
 * bounds (never clipped or pushed out), and what that width drops must actually
 * be gone rather than merely pushed off. Zoom outlives the other two, so the
 * tiny tier passes `['Zoom']`. Throws — so the failure surfaces in Storybook's
 * Interactions panel — if a control is missing, collapsed to zero size, sticking
 * outside the header's horizontal extent, or present when it should have gone.
 */
function assertPaneActions(expected: readonly PaneAction[]) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const EPS = 0.5;

    // Returns a human-readable reason the controls aren't as expected yet, or
    // null once every expected one sits inside the header bounds and the rest
    // have left.
    const violation = (): string | null => {
      const header = canvasElement.querySelector<HTMLElement>('.bg-app-bg');
      if (!header) return 'header container not found';
      const bounds = header.getBoundingClientRect();
      for (const name of PANE_ACTIONS) {
        const el = canvasElement.querySelector<HTMLElement>(`[aria-label="${name}"]`);
        if (!expected.includes(name)) {
          if (el) return `${name} button should have been dropped at this width`;
          continue;
        }
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
    // have settled, instead of guessing a fixed delay. Surface the last reason
    // if it never settles within the timeout.
    await waitForPrimedState();
    await waitForCondition(() => violation() === null, { timeoutMs: 1000 });
    const reason = violation();
    if (reason) throw new Error(reason);
  };
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
    width: { control: 'number' },
    dirty: { control: 'boolean' },
    reducedMotion: { control: 'boolean' },
    mouseCaptured: { control: 'boolean' },
    noteCount: { control: 'number' },
  },
  args: {
    mode: 'command',
    isSelected: true,
    isRenaming: false,
    width: 360,
    reducedMotion: false,
    mouseCaptured: false,
    noteCount: 0,
  },
};

export default meta;
type Story = StoryObj<typeof TabStory>;

export const Default: Story = {
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

// --- Command-keyed WATCHING (docs/specs/alert.md) --------------------------
//
// The context acts on the *running command's* rule, not on this pane, so what
// it offers depends on what the pane is running and whether a rule exists.

export const AlertRightClickDialog: Story = contextDialogStory({
  status: 'NOTHING_TO_SHOW',
  command: 'claude --resume',
});

/** A pane at a prompt: no argv0, so the dialog explains instead of offering a switch. */
export const AlertDialogNoCommandRunning: Story = contextDialogStory({
  status: 'WATCHING_DISABLED',
  command: null,
});

export const TodoOnly: Story = {
  parameters: primedPane({ status: 'WATCHING_DISABLED', todo: true }),
};

// A program that rang was, by definition, running something — so the
// notification dialogs show the rule switch alongside the notification detail.

export const TodoWithNotificationPreview: Story = {
  parameters: primedPane({ status: 'WATCHING_DISABLED', todo: true, notification: NOTIFICATIONS.osc777TitleAndBody, command: 'pnpm test' }),
  play: openTodoNotificationPreview,
};

export const TodoWithLongNotificationPreview: Story = {
  args: {
    width: 320,
  },
  parameters: primedPane({ status: 'WATCHING_DISABLED', todo: true, notification: NOTIFICATIONS.longBody, command: 'pnpm test' }),
  play: openTodoNotificationPreview,
};

export const NotificationDialogTitleAndBody: Story = contextDialogStory({
  status: 'ALERT_RINGING',
  todo: true,
  notification: NOTIFICATIONS.osc777TitleAndBody,
  command: 'pnpm test',
});

export const NotificationDialogBodyOnly: Story = contextDialogStory({
  status: 'ALERT_RINGING',
  todo: true,
  notification: NOTIFICATIONS.osc9BodyOnly,
  command: 'pnpm test',
});

export const NotificationDialogTitleOnly: Story = contextDialogStory({
  status: 'ALERT_RINGING',
  todo: true,
  notification: NOTIFICATIONS.osc99TitleOnly,
  command: 'pnpm test',
});

export const NotificationDialogLongBody: Story = contextDialogStory({
  status: 'ALERT_RINGING',
  todo: true,
  notification: NOTIFICATIONS.longBody,
  command: 'pnpm test',
});

export const CompactWidth: Story = {
  args: {
    width: 220,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

export const MinimalWidth: Story = {
  args: {
    width: 150,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

export const LongTitleWithTodoAndRinging: Story = {
  args: {
    width: 360,
  },
  parameters: primedPane({ status: 'ALERT_RINGING', todo: true, userTitle: LONG_TITLE }),
};

export const RenameRejectedReserved: Story = {
  args: {
    isRenaming: true,
    actions: actionsRejecting('reserved'),
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
  play: submitReservedRename,
};

// --- The pane-action group stays visible as the header shrinks -------------
//
// These stories drive the header down through the `minimal` tier and into
// `tiny`, asserting in their play function that whatever the width still
// affords stays rendered and fully inside the header bounds. Zoom is the last
// to go (`docs/specs/layout.md` → "Pane header responsive sizing"), so the
// 76px story expects it alone. The assertion uses live layout geometry, so it
// confirms the controls in the real Storybook browser.

export const NarrowControlsVisible: Story = {
  args: {
    width: 110,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
  play: assertPaneActions(PANE_ACTIONS),
};

// A Surface with notes at 100px: the notepad has to yield, or it pushes kill
// past the header's right edge. Only a live-geometry check catches that — jsdom
// has no layout, so the unit test can pin presence but not clipping.
export const NarrowWithNotesControlsVisible: Story = {
  args: {
    width: 100,
    noteCount: 2,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
  play: assertPaneActions(PANE_ACTIONS),
};

// The unsaved-change dot sits at the header root, outside the clipping region,
// so it costs the group 12px that the title cannot give back. 120px is inside
// the `minimal-tight` band: with notes and a dot the notepad must yield.
export const NarrowDirtyWithNotesControlsVisible: Story = {
  args: {
    width: 120,
    noteCount: 2,
    dirty: true,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
  play: assertPaneActions(PANE_ACTIONS),
};

// 76px is the tiny tier: minimize and kill are gone and zoom carries the header.
export const ExtremelyNarrowControlsVisible: Story = {
  args: {
    width: 76,
  },
  parameters: primedPane({ status: 'ALERT_RINGING', todo: true }),
  play: assertPaneActions(['Zoom']),
};

export const NarrowWithMouseCaptureControlsVisible: Story = {
  args: {
    width: 120,
    mouseCaptured: true,
  },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
  play: assertPaneActions(PANE_ACTIONS),
};

// Notepad icons with notes across the full, compact, and minimal tiers.
// Default and MinimalWidth cover the empty notepad.
export const NotepadWithNotes: Story = {
  args: { noteCount: 3 },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

export const NotepadCompactWidth: Story = {
  args: { width: 220, noteCount: 3 },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

export const NotepadMinimalWidthWithNotes: Story = {
  args: { width: 150, noteCount: 2 },
  parameters: primedPane({ status: 'NOTHING_TO_SHOW' }),
};

export const NarrowLongTitleControlsVisible: Story = {
  args: {
    width: 130,
  },
  parameters: primedPane({ status: 'ALERT_RINGING', todo: true, userTitle: LONG_TITLE }),
  play: assertPaneActions(PANE_ACTIONS),
};
