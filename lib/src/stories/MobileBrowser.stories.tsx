import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MobileBrowserPane, type MobileBrowserStatus } from '../components/MobileBrowserPane';
import { MobileCloseDialog, type MobileCloseDialogState } from '../components/MobileCloseDialog';
import { MobileSettings } from '../components/MobileSettings';
import { MobileTerminalUi, type MobileTerminalSessionItem, type MobileTerminalView } from '../components/MobileTerminalUi';
import { MobileWall, type MobileWallSession } from '../components/MobileWall';
import { flattenScenario, initPlatform, type FakeScenario } from '../lib/platform';

const TOOL = 'surface:1';
const BROWSER = 'surface:2';
const TERMINAL = 'surface:3';
const STREAMING = 'surface:4';

const SESSIONS: MobileWallSession[] = [
  { id: TOOL, title: 'README.md', kind: 'tool' },
  { id: BROWSER, title: 'localhost:5173', kind: 'browser' },
  { id: TERMINAL, title: 'zsh' },
  { id: STREAMING, title: 'dormouse.sh', kind: 'browser', browserDisplay: 'agent-browser-resize' },
];

const SECONDARY: Record<string, string> = {
  [TOOL]: '~/projects/dormouse',
  [BROWSER]: 'Dormouse docs',
  [TERMINAL]: '~/projects/dormouse',
  [STREAMING]: 'agent-browser',
};

const SCENARIO: FakeScenario = {
  name: 'mobile-browser',
  chunks: [{ delay: 0, data: '\x1b[32mdor open README.md\x1b[0m\r\nServing builtin:file\r\n' }],
};

/** Stands in for a framed page: a document of its own, with its own colors. */
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:16px/1.5 system-ui;color:#1c1c1e;background:#fff">
<div style="padding:16px"><h1 style="font-size:24px;margin:0 0 12px">Dormouse</h1>
<p>A mouse-friendly multitasking terminal, as a Tool's page shows it.</p>
<p><label>A field the page owns <input style="font:inherit;width:100%;box-sizing:border-box;padding:6px" value="Tap to type"></label></p>
${'<p>The page scrolls by itself, inside the frame, under the header that stays.</p>'.repeat(12)}
</div></body>`;

/** A screencast is not built, so one stands in here: what shows the browser is the pane's `view`. */
function FakeView({ title }: { title: string }) {
  return <iframe title={title} srcDoc={PAGE} className="block h-full w-full border-0 bg-white" />;
}

function Frame({ status, active: initial = TOOL, view: initialView = 'terminal', dialog }: {
  status: MobileBrowserStatus;
  active?: string;
  view?: MobileTerminalView;
  dialog?: MobileCloseDialogState;
}) {
  useState(() => initPlatform('fake'));
  const [active, setActive] = useState(initial);
  const [view, setView] = useState<MobileTerminalView>(initialView);
  // A Tool opens on its page; the switch is remembered per Session.
  const [terminalOver, setTerminalOver] = useState<ReadonlySet<string>>(new Set());
  const session = SESSIONS.find(({ id }) => id === active);
  const browserShown = session?.kind === 'browser' || (session?.kind === 'tool' && !terminalOver.has(active));
  const items: MobileTerminalSessionItem[] = SESSIONS.map(({ id, title, kind, browserDisplay }) => ({
    id,
    kind,
    browserDisplay,
    title: title ?? '',
    secondary: SECONDARY[id],
    active: id === active,
    episode: null,
  }));

  return (
    <div className="overflow-hidden border border-border shadow-2xl" style={{ width: 390, height: 760 }}>
      <MobileTerminalUi
        className="h-full"
        browserShown={browserShown}
        activeView={view}
        onViewChange={setView}
        sessions={items}
        settings={<MobileSettings persist={false} />}
        onSessionSelect={setActive}
        terminal={(
          <MobileWall
            sessions={SESSIONS}
            sessionItems={items}
            onSessionTodoClear={null}
            activeSessionId={active}
            onActiveSessionChange={setActive}
            onShowSessions={() => setView('sessions')}
            showKillButton={false}
            browserShown={browserShown}
            onToolBrowserShownChange={(shown) => setTerminalOver((current) => {
              const next = new Set(current);
              if (shown) next.delete(active);
              else next.add(active);
              return next;
            })}
            onBrowserClose={() => {}}
            browser={session?.kind === 'terminal' || !session?.kind ? null : (
              <MobileBrowserPane
                status={status}
                view={<FakeView title={session.browserDisplay ? 'Screencast' : 'Page'} />}
                onShowSessions={() => setView('sessions')}
              />
            )}
          />
        )}
      />
      {dialog ? <MobileCloseDialog state={dialog} /> : null}
    </div>
  );
}

const meta: Meta<typeof Frame> = {
  title: 'Pocket/Browser',
  component: Frame,
  parameters: {
    layout: 'centered',
    fakePty: { scenario: flattenScenario(SCENARIO) },
  },
  args: { status: { kind: 'ready' } },
};

export default meta;
type Story = StoryObj<typeof Frame>;

/** A row each for a Tool, a browser Surface, a terminal, and a stream. */
export const SessionsList: Story = {
  args: { view: 'sessions' },
};

/** A Tool opens on its browser: its modes at far left, as the desktop's, and no bottom bar. */
export const ToolPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('region', { name: 'Touch mode' })).toBeNull();
    await expect(canvas.getByTitle('Show sessions')).toBeVisible();
    await expect(canvas.getByLabelText('Browser')).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByLabelText('Terminal')).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.getByLabelText('Kill')).toBeVisible();
  },
};

/** Its terminal is one tap away, and the bar comes back with it. */
export const ToolTerminal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText('Terminal'));
    await expect(canvas.getByRole('region', { name: 'Touch mode' })).toBeVisible();
    await expect(canvas.getByLabelText('Terminal')).toHaveAttribute('aria-pressed', 'true');
  },
};

/** A browser Surface has no terminal to switch to, so its glyph only names its display. */
export const BrowserPage: Story = {
  args: { active: BROWSER },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByLabelText('Terminal')).toBeNull();
  },
};

/** Where agent-browser and Playwright land: the same layout, wearing the desktop's robot glyph. A stand-in; no stream is built. */
export const StreamingPreview: Story = {
  args: { active: STREAMING },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-browser-display-mode="agent-browser-resize"]')).not.toBeNull();
  },
};

/** A plain terminal is unchanged: Pocket offers no kill for one. */
export const PlainTerminal: Story = {
  args: { active: TERMINAL },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByLabelText('Kill')).toBeNull();
  },
};

export const Connecting: Story = { args: { status: { kind: 'connecting' } } };
export const Loading: Story = { args: { status: { kind: 'loading' } } };
export const Relayed: Story = { args: { status: { kind: 'relayed' } } };
export const PageGone: Story = { args: { status: { kind: 'gone' } } };
export const Failed: Story = {
  args: { status: { kind: 'failed', message: 'frame refused: a remote device frames pages on this machine only' } },
};

const noop = () => {};
/** A close the computer says must confirm: the desktop's letter, tapped. */
export const CloseConfirm: Story = {
  args: { dialog: { kind: 'confirm', char: 'r', onConfirm: noop, onCancel: noop } },
};
/** The desktop's Save / Discard / Cancel. */
export const CloseUnsaved: Story = {
  args: { dialog: { kind: 'unsaved', labels: ['README.md'], onSave: noop, onDiscard: noop, onCancel: noop } },
};
export const CloseSaveFailed: Story = {
  args: { dialog: { kind: 'unsaved', labels: ['README.md'], error: 'New edits arrived while saving. Save again or cancel.', onSave: noop, onDiscard: noop, onCancel: noop } },
};
/** The desktop's refusal, as it reads there. */
export const CloseRefused: Story = {
  args: { dialog: { kind: 'refused', message: 'This terminal is already closing', onDismiss: noop } },
};
