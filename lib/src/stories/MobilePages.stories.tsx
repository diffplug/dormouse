import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MobilePagePane, type MobilePageStatus } from '../components/MobilePagePane';
import { MobileSettings } from '../components/MobileSettings';
import { MobileTerminalUi, type MobileTerminalSessionItem, type MobileTerminalView } from '../components/MobileTerminalUi';
import { MobileWall, type MobileWallSession } from '../components/MobileWall';
import { flattenScenario, initPlatform, type FakeScenario } from '../lib/platform';

const TOOL = 'surface:1';
const BROWSER = 'surface:2';
const TERMINAL = 'surface:3';

const SESSIONS: MobileWallSession[] = [
  { id: TOOL, title: 'README.md', kind: 'tool' },
  { id: BROWSER, title: 'localhost:5173', kind: 'page' },
  { id: TERMINAL, title: 'zsh' },
];

const SECONDARY: Record<string, string> = {
  [TOOL]: '~/projects/dormouse',
  [BROWSER]: 'Dormouse docs',
  [TERMINAL]: '~/projects/dormouse',
};

const SCENARIO: FakeScenario = {
  name: 'mobile-pages',
  chunks: [{ delay: 0, data: '\x1b[32mdor open README.md\x1b[0m\r\nServing builtin:file\r\n' }],
};

/** Stands in for a framed page: a document of its own, with its own colors. */
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:16px/1.5 system-ui;color:#1c1c1e;background:#fff">
<div style="padding:16px"><h1 style="font-size:24px;margin:0 0 12px">Dormouse</h1>
<p>A mouse-friendly multitasking terminal, as a Tool's page shows it.</p>
<p><label>A field the page owns <input style="font:inherit;width:100%;box-sizing:border-box;padding:6px" value="Tap to type"></label></p>
${'<p>The page scrolls by itself, inside the frame, under the header that stays.</p>'.repeat(12)}
</div></body>`;

function FakePage() {
  return <iframe title="Page" srcDoc={PAGE} className="block h-full w-full border-0 bg-white" />;
}

function Frame({ status, active: initial = TOOL, view: initialView = 'terminal' }: {
  status: MobilePageStatus;
  active?: string;
  view?: MobileTerminalView;
}) {
  useState(() => initPlatform('fake'));
  const [active, setActive] = useState(initial);
  const [view, setView] = useState<MobileTerminalView>(initialView);
  // A Tool opens on its page; the switch is remembered per Session.
  const [terminalOver, setTerminalOver] = useState<ReadonlySet<string>>(new Set());
  const session = SESSIONS.find(({ id }) => id === active);
  const pageShown = session?.kind === 'page' || (session?.kind === 'tool' && !terminalOver.has(active));
  const items: MobileTerminalSessionItem[] = SESSIONS.map(({ id, title, kind }) => ({
    id,
    kind,
    title: title ?? '',
    secondary: SECONDARY[id],
    active: id === active,
    episode: null,
  }));

  return (
    <div className="overflow-hidden border border-border shadow-2xl" style={{ width: 390, height: 760 }}>
      <MobileTerminalUi
        className="h-full"
        pageShown={pageShown}
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
            pageShown={pageShown}
            onPageShownChange={(shown) => setTerminalOver((current) => {
              const next = new Set(current);
              if (shown) next.delete(active);
              else next.add(active);
              return next;
            })}
            onPageReload={status.kind === 'ready' ? () => {} : undefined}
            page={session?.kind === 'terminal' || !session?.kind ? null : (
              <MobilePagePane status={status} frame={<FakePage />} onShowSessions={() => setView('sessions')} />
            )}
          />
        )}
      />
    </div>
  );
}

const meta: Meta<typeof Frame> = {
  title: 'Pocket/Pages',
  component: Frame,
  parameters: {
    layout: 'centered',
    fakePty: { scenario: flattenScenario(SCENARIO) },
  },
  args: { status: { kind: 'ready' } },
};

export default meta;
type Story = StoryObj<typeof Frame>;

/** A row each for a Tool, a browser Surface, and a terminal. */
export const SessionsList: Story = {
  args: { view: 'sessions' },
};

/** A Tool opens on its page, under the header, with no bottom bar. */
export const ToolPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('region', { name: 'Touch mode' })).toBeNull();
    await expect(canvas.getByTitle('Show sessions')).toBeVisible();
    await expect(canvas.getByLabelText('Show terminal')).toBeVisible();
    await expect(canvas.getByLabelText('Reload page')).toBeVisible();
  },
};

/** Its terminal is one tap away, and the bar comes back with it. */
export const ToolTerminal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText('Show terminal'));
    await expect(canvas.getByRole('region', { name: 'Touch mode' })).toBeVisible();
    await expect(canvas.getByLabelText('Show page')).toBeVisible();
    await expect(canvas.queryByLabelText('Reload page')).toBeNull();
  },
};

/** A browser Surface has no terminal to switch to. */
export const BrowserPage: Story = {
  args: { active: BROWSER },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByLabelText('Show terminal')).toBeNull();
  },
};

/** A plain terminal is unchanged. */
export const PlainTerminal: Story = {
  args: { active: TERMINAL },
};

export const Connecting: Story = { args: { status: { kind: 'connecting' } } };
export const Loading: Story = { args: { status: { kind: 'loading' } } };
export const Relayed: Story = { args: { status: { kind: 'relayed' } } };
export const PageGone: Story = { args: { status: { kind: 'gone' } } };
export const Failed: Story = {
  args: { status: { kind: 'failed', message: 'frame refused: a remote device frames pages on this machine only' } },
};
